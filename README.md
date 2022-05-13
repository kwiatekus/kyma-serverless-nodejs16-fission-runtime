
## changed contract in the runtime CM definition for nodejs14:

```
ARG base_image=eu.gcr.io/kyma-project/function-runtime-nodejs14:PR-14284
FROM ${base_image}
USER root
ARG SRC_DIR=/src

RUN mkdir -p /usr/src/app/function
WORKDIR /usr/src/app/function

COPY $SRC_DIR/package.json /usr/src/app/function/package.json

RUN npm install
COPY $SRC_DIR /usr/src/app/function
RUN ls -l /usr/src/app/function
WORKDIR /usr/src/app

USER 1000
```

## sample config.yaml

```
name: my-fn
namespace: default
runtime: nodejs14
runtimeImageOverride: kwiatekus/kyma-serverless-nodejs16-fission-runtime:local
```