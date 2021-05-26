url=011533361443.dkr.ecr.us-east-1.amazonaws.com
registry=cloud-compile
docker build -t $registry:latest .
docker tag $registry:latest $url/$registry:latest
aws ecr get-login-password --region us-east-1 --profile cloud-compile | docker login --username AWS --password-stdin $url
docker push $url/$registry:latest
