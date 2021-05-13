#!/usr/bin/env python3

import asyncio
import aiohttp
import sys, getopt, glob, os, json, base64, tempfile
import zlib
import argparse

base_lambda_url = "https://i3jv6iay77.execute-api.us-east-2.amazonaws.com/dev/"
lambda_split_url = base_lambda_url + "split/" 
lambda_compile_url = base_lambda_url + "compile/"


async def split(output_path, input_path, compressed, chunks):

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
        'chunks': chunks
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(lambda_split_url,
                        json=payload) as resp:

                if resp.status == 200:
                    s3_keys = json.loads(await resp.text())
                    s3_keys = "\n".join(s3_keys) # join keys with new line


                    if output_path == '-':
                        sys.stdout.buffer.write(s3_keys)
                        sys.stdout.flush()
                    else:
                        with open(output_path, 'w') as fd:
                            fd.write(s3_keys)
                else:
                    print(resp)
                    # first load top level response
                    json_resp = json.loads(await resp.text())
                    if 'message' in json_resp: # check for error messages from AWS
                        print("Lambda message: " + json_resp['message'], file=sys.stderr)
                        raise Exception("Failed execution: " + json_resp['message'])

                    # load second level body
                    body = json.loads(json_resp['body'])
                    print('Splitter Error: ' + str(body), file=sys.stderr)

                    raise Exception("Failed to split file")
    except Exception as e:
        print("Unable to split {} due to {}".format(input_path, e.__class__), file=sys.stderr)


async def compile(output_path, input_path, clang_cmd):

    if input_path == '-':
        s3_key = sys.stdin.buffer.read()
    else:
        with open(input_path, 'rb') as f:
            s3_key = f.read()

    params = {
        's3_key': s3_key,
        'clang_cmd': clang_cmd,
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(lambda_compile_url,
                        params=params) as resp:

                if resp.status == 200:
                    output = await resp.text()

                    if output_path == '-':
                        sys.stdout.buffer.write(base64.b64decode(output))
                        sys.stdout.flush()
                    else:
                        with open(output_path, 'wb') as fd:
                            fd.write(base64.b64decode(output))
                else:
                    # first load top level response
                    json_resp = json.loads(await resp.text())
                    if 'message' in json_resp: # check for error messages from AWS
                        print("Lambda message: " + json_resp['message'], file=sys.stderr)
                        raise Exception("Failed execution: " + json_resp['message'])

                    # load second level body
                    body = json.loads(json_resp['body'])
                    print('Compiler Error: ' + str(body), file=sys.stderr)
                    raise Exception("Failed to split file")

    except Exception as e:
        print("Unable to get compiled file {} due to {}.".format(s3_key, e.__class__), file=sys.stderr)


async def main(output_path, input_path, compressed, clang_cmd, to_split, chunks):

    if to_split:
        await split(output_path, input_path, compressed, chunks)
    else:
        await compile(output_path, input_path, clang_cmd)

    print("Finished requests to lambda.", file=sys.stdout)

def checkParams():
    parser = argparse.ArgumentParser()
    parser.add_argument('-compress', action='store_true', help="Flag set if file compressed")
    parser.add_argument('-o', '--output', type=str, help="Output file", required=True)
    parser.add_argument('-clang', type=str, help="Command to send to clang")
    parser.add_argument('-split', action='store_true', help="Flag set will call splitter instead of compiler")
    parser.add_argument('-chunks', type=int, help="Number of chunks to split file into")
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

    if not (os.path.isfile(input_path) or input_path == '-'):
        print("Specify a valid file or use stdin (-)", file=sys.stderr)
        sys.exit(2)

    return output_path, input_path, compressed, clang_cmd, to_split, chunks

if __name__ == "__main__":
    output_path, input_path, compressed, clang_cmd, to_split, chunks = checkParams()
    asyncio.run(main(output_path, input_path, compressed, clang_cmd, to_split, chunks))
