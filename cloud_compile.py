#!/usr/bin/env python3

import asyncio
import aiohttp
import sys, os, base64, uuid
import zlib
import argparse
import requests

base_lambda_url = "https://mwqk8dbp1f.execute-api.us-east-1.amazonaws.com/dev/"
lambda_upload_url = base_lambda_url + 'upload/'
lambda_split_url = base_lambda_url + "split/" 
lambda_compile_url = base_lambda_url + "compile/"

def log(*args):
    print(*args, file=sys.stderr)

def split(data, clang_cmd, chunks=1, compressed=True):
    # get the presigned upload url
    resp = requests.get(lambda_upload_url)
    assert resp.status_code == 200
    body = resp.json()
    obj_key = body['key']

    # do the actual upload
    resp = requests.put(body['url'], data=data)
    assert resp.status_code == 200

    # request frontend+split on the obj
    payload = {
        'key': obj_key,
        'chunks': chunks,
        'clang_cmd': clang_cmd
    }
    resp = requests.post(lambda_split_url, json=payload)
    if resp.status_code != 200:
      log('!!! error spliting', resp.text)
    body = resp.json()
    if resp.status_code == 200:
        return body['s3_keys']
    else:
        if 'message' in body: # check for error messages from AWS
            log("Lambda message: " + body['message'])
        # load second level body
        log('Splitter Error: ', str(body))


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
                bytes = base64.b64decode(body['data'])
                if output_path == '-':
                    sys.stdout.buffer.write(bytes)
                    sys.stdout.flush()
                else:
                    with open(output_path, 'wb') as fd:
                        fd.write(bytes)

                # exit with same status code as splitter
                # sys.exit(body['status'])

            else:
                body = json.loads(body.decode('utf8'))
                if 'message' in body: # check for error messages from AWS
                    log("Lambda message: " + body['message'])

                log('Compiler Error: ' + str(body))

async def main(output_path, input_path, compressed, clang_cmd, to_split, chunks):

    if to_split:
        await split(output_path, input_path, compressed, chunks, clang_cmd)
    else:
        # in this case, input_path = s3_key
        await compile(output_path, input_path, clang_cmd)

    log("Finished requests to lambda.")

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
        log("Error parsing arguments: {}.".format(e.__class__))
        sys.exit(2)
        
    if to_split and (not (os.path.isfile(input_path) or input_path == '-')):
        log("Specify a valid file or use stdin (-)")
        sys.exit(2)

    return output_path, input_path, compressed, clang_cmd, to_split, chunks

if __name__ == "__main__":
    output_path, input_path, compressed, clang_cmd, to_split, chunks = checkParams()
    asyncio.run(main(output_path, input_path, compressed, clang_cmd, to_split, chunks))
