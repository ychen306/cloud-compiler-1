aws ecr get-login-password --region us-east-2 --profile cloud-compiler | docker login --username AWS --password-stdin 914213759135.dkr.ecr.us-east-2.amazonaws.com
docker push 914213759135.dkr.ecr.us-east-2.amazonaws.com/cloud-compiler-lambda:latest
