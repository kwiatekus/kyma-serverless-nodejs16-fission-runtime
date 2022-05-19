
IMAGE_DOMAIN=kwiatekus
IMAGE_TAG=auto-tracer-node
IMAGE_FULL_NAME=${IMAGE_DOMAIN}/kyma-serverless-nodejs16-fission-runtime:${IMAGE_TAG}

build:
	docker build -t ${IMAGE_FULL_NAME}  . --build-arg NODE_BASE_IMG=16-alpine3.14

push:
	docker push "${IMAGE_FULL_NAME}"

default: build

all: build push
