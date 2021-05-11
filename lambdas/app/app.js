const fs = require('fs');
const zlib = require('zlib');
const child_process = require('child_process');
const uuid = require('uuid');
const express = require('express');
const sls = require('serverless-http');
const AWS = require('aws-sdk');
const app = express();

app.use(express.json());

const S3 = new AWS.S3();

// allows for async/await implementation of streams
const streamToFile = (input_stream, file_path) => {
  return new Promise((resolve, reject) => {
    const file_write_stream = fs.createWriteStream(file_path)
    input_stream
      .pipe(file_write_stream)
      .on('finish', resolve)
      .on('error', reject)
  });
};

// compile split files
app.get('/compile', async (req, res, next) => {
  const s3_key = req.query.s3_key;
  const clang_cmd = req.query.clang_cmd;

  // params to fetch file from s3 bucket
  const params = {
    Bucket: 'cloudcompilerbucket',
    Key: s3_key,
  };

  // get split file from s3 and write it to /tmp/in
  try {
    const s3_stream = S3.getObject(params).createReadStream();
    await streamToFile(s3_stream, '/tmp/in');
  } catch(error) {
    console.error("Error fetching file from S3 bucket: ", error);
    res.status(500).json({
      'type': 's3_read',
      'message': "Error fetching file from S3 bucket.",
    });
    next();
  }

  // run clang on split file and write object file to disk
  var response_data;
  try {
    response_data = Buffer.from(child_process.execSync(`clang-12 ${clang_cmd} /tmp/in -o -`));
    response_data = response_data.toString('base64');
  } catch(error) {
    const execution_error = {
      'type': 'compiler',
      'status': error.status,
      'message': error.message,
      'stderr': error.stderr.toString(),
      'stdout': error.stdout.toString()
    };

    res.status(500).json(execution_error);
    next();
  }

  // send base64 encoded object file back to user
  res.status(200).send(response_data);
});

// split input into multiple files
app.post('/split', async (req, res, next) => {
  const chunks = req.body.chunks;
  const data = Buffer.from(req.body.data, 'base64');

  // write input file to disk
  try {
    fs.writeFileSync('/tmp/in', data);
  } catch(error) {
    console.error("Error writing data to lambda disk: ", error);
    res.status(500).json({
      'type': 'write_file',
      'message': "Error writing data to lambda disk."
    });
    next();
  }

  // split files and output to /tmp/split/
  try {
    fs.mkdirSync('/tmp/split/');
    child_process.execSync(`llvm-split-12 -j${chunks} /tmp/in -o /tmp/split/`);
  } catch(error) {
    console.error("Error splitting files: ", error);
    res.status(500).json({
      'type': 'splitter',
      'status': error.status,
      'message': error.message,
      'stderr': error.stderr.toString(),
      'stdout': error.stdout.toString()
    });
    next();
  }

  var s3_keys = [];
  // upload all split files to s3 with a unique uuid4 key
  try {
    var params = [];

    const files = fs.readdirSync('/tmp/split/'); // read split files
    // generate params for each file
    files.forEach(file => {
      var s3_file_key = uuid.v4();
      var param = {
        Bucket: 'cloudcompilerbucket',
        Key: s3_file_key,
        Body: fs.readFileSync('/tmp/split/' + file)
      };
      params.push(param);
    });

    // push to s3 bucket
    await Promise.all(
      params.map(param => s3.upload(param).promise())
    );
  } catch(error) {
    console.error("Error uploading split files to s3 bucket: ", error);
    res.status(500).json({
      'type': 's3_write',
      'message': "Error uploading split files to s3 bucket."
    });
    next();
  }

  // send keys for each split file back to user
  res.status(200).send(s3_keys);
});

module.exports.handler = sls(app);
