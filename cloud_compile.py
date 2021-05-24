#!/usr/bin/env python3

import asyncio
import aiohttp
import sys, os, base64, uuid
import zlib
import argparse

base_lambda_url = "https://z88e24e0a9.execute-api.us-east-2.amazonaws.com/dev/"
lambda_split_url = base_lambda_url + "split/" 
lambda_compile_url = base_lambda_url + "compile/"


async def split(output_path, input_path, compressed, chunks, clang_cmd):

    if input_path == '-':
        data = sys.stdin.buffer.read()
    else:
        with open(input_path, 'rb') as f:
          data = f.read()

    if not data:
        return

    if compressed:
        data = zlib.compress(data)
    
    data = base64.b64encode(data).decode('utf8')

    payload = {
        'compressed': compressed,
        'data': data,
        'chunks': chunks,
        'clang_cmd': clang_cmd
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(lambda_split_url,
                    json=payload) as resp:

            body = await resp.json()
            if resp.status == 200:
                s3_keys = body['s3_keys']
                s3_keys = "\n".join(s3_keys) # join keys with new line
                s3_keys += "\n"

                print("Splitter Stdout: ", body['stdout'])
                print("Splitter Stderr: ", body['stderr'])

                if output_path == '-':
                    sys.stdout.write(s3_keys)
                    sys.stdout.flush()
                else:
                    with open(output_path, 'w') as fd:
                        fd.write(s3_keys)

                # exit with same status code as splitter
                # sys.exit(body['status'])

            else:
                if 'message' in body: # check for error messages from AWS
                    print("Lambda message: " + body['message'], file=sys.stderr)

                # load second level body
                print('Splitter Error: ', str(body), file=sys.stderr)


async def compile(output_path, s3_key, clang_cmd):
    if s3_key == '-':
        s3_key = sys.stdin.read().rstrip()

    payload = {
        's3_key': s3_key,
        'clang_cmd': clang_cmd,
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(lambda_compile_url,
                    json=payload) as resp:

            body = await resp.json()
            if resp.status == 200:

                if 'stderr' in body:
                    print("Compiler Stderr: ", body['stderr'])
                    print("Compiler Status: ", body['status'])

                if output_path == '-':
                    sys.stdout.buffer.write(base64.b64decode(body['data']))
                    sys.stdout.flush()
                else:
                    with open(output_path, 'wb') as fd:
                        fd.write(base64.b64decode(body['data']))

                # exit with same status code as splitter
                # sys.exit(body['status'])

            else:
                if 'message' in body: # check for error messages from AWS
                    print("Lambda message: " + body['message'], file=sys.stderr)

                print('Compiler Error: ' + str(body), file=sys.stderr)

async def main(output_path, input_path, compressed, clang_cmd, to_split, chunks):

    if to_split:
        await split(output_path, input_path, compressed, chunks, clang_cmd)
    else:
        # in this case, input_path = s3_key
        await compile(output_path, input_path, clang_cmd)

    print("Finished requests to lambda.")

def checkParams():
    parser = argparse.ArgumentParser()
    parser.add_argument('-compress', action='store_true', help="Flag set if file compressed")
    parser.add_argument('-o', '--output', type=str, help="Output file", required=True)
    parser.add_argument('-clang', type=str, help="Command to send to clang")
    parser.add_argument('-split', action='store_true', help="Flag set will call splitter instead of compiler")
    parser.add_argument('-chunks', type=int, default=1, help="Number of chunks to split file into")
    parser.add_argument('file', help="File to compile")

    args = parser.parse_args()
    try:
        clang_cmd = args.clang
        compressed = args.compress
        to_split = args.split
        chunks = args.chunks

        input_path = args.file
        output_path = args.output
    except Exception as e:
        print("Error parsing arguments: {}.".format(e.__class__), file=sys.stderr)
        sys.exit(2)
        
    if to_split and (not (os.path.isfile(input_path) or input_path == '-')):
        print("Specify a valid file or use stdin (-)", file=sys.stderr)
        sys.exit(2)

    return output_path, input_path, compressed, clang_cmd, to_split, chunks

if __name__ == "__main__":
    output_path, input_path, compressed, clang_cmd, to_split, chunks = checkParams()
    asyncio.run(main(output_path, input_path, compressed, clang_cmd, to_split, chunks))
