# Define custom function directory
ARG FUNCTION_DIR="/function"

FROM node:12-buster as build-image

# Include global arg in this stage of the build
ARG FUNCTION_DIR

# Install aws-lambda-cpp build dependencies

RUN apt-get update && \
    apt-get install -y \
    g++ \
    make \
    cmake \
    unzip \
    libcurl4-openssl-dev 

# Copy function code
COPY package.json ${FUNCTION_DIR}/ 

WORKDIR ${FUNCTION_DIR}

# If the dependency is not in package.json uncomment the following line
# RUN npm install aws-lambda-ric

RUN npm install

# Install LLVM
RUN apt-get update && \
    apt-get install -y \
    apt-utils \
    gnupg \
    wget \
    lsb-release \ 
    software-properties-common && \
    wget https://apt.llvm.org/llvm.sh && \
    chmod +x llvm.sh && \
    wget -O - https://apt.llvm.org/llvm-snapshot.gpg.key | apt-key add - && \
    ./llvm.sh 12

# Install the custom splitter
ADD ./split/CMakeLists.txt ./split/split.cpp /split/
RUN mkdir split-build && \
      cd split-build && \
      cmake /split -DCMAKE_INSTALL_PREFIX=/usr/bin -DCMAKE_BUILD_TYPE=Release && \
      make install

# Copy function code (do this last so that caching works better)
COPY app.js ${FUNCTION_DIR}

ENTRYPOINT ["/usr/local/bin/npx", "aws-lambda-ric"]
CMD ["app.handler"]
