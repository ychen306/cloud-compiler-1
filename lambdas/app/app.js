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
const streamToFile = (input_stream, file_path, decompress) => {
  return new Promise((resolve, reject) => {
    const file_write_stream = fs.createWriteStream(file_path);
    if (decompress) input_stream = input_stream.pipe(zlib.createInflate());
    input_stream
      .pipe(file_write_stream)
      .on('finish', resolve)
      .on('error', reject)
  });
};

app.get('/upload', async (req, res, next) => {
  try {
    const key = uuid.v4();
    const url = S3.getSignedUrl('putObject', {
      Bucket: 'cloud-compile',
      Key: key,
    });
    res.status(200).json({
      'url': url,
      'key': key
    });
  } catch (error) {
    res.status(500).json({
      'message': 'Error getting presigned put-obj url' + JSON.stringify(error)
    });
  }
});

// compile split files
app.post('/compile', async (req, res, next) => {
  const s3_key = req.body.s3_key;
  const clang_cmd = req.body.clang_cmd;

  // params to fetch file from s3 bucket
  const params = {
    Bucket: 'cloud-compile',
    Key: s3_key,
  };

  // get split file from s3 and write it to /tmp/in
  try {
    const s3_stream = S3.getObject(params).createReadStream();
    await streamToFile(s3_stream, '/tmp/in', false);
  } catch(error) {
    console.error("Error fetching file from S3 bucket: ", error);
    res.status(500).json({
      'type': 's3_read',
      'message': "Error fetching file from S3 bucket.",
    });
    next();
  }

  // run clang on split file and write object file to disk
  var compile_result;

  try {
    var args = clang_cmd.split(' ');
    args.push('/tmp/in', '-o', '/tmp/out');
    compile_result = child_process.spawnSync('clang-12', args);
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

  buf = fs.readFileSync('/tmp/out');
  res.setHeader('content-type', 'text/plain');
  res.status(200).send(buf.toString('base64'));

  // remove file from S3 after it has been compiled and sent back to user
  S3.deleteObject(params, (err, data) => {
    if(err) {
      console.error(err, err.stack);
    } else {
      console.log(data);
    }
  });
});

// split input into multiple files
app.post('/split', async (req, res, next) => {
  const chunks = req.body.chunks;
  const clang_cmd = req.body.clang_cmd;
  const key = req.body.key

  var frontend_result;
  try {
    const s3_stream = S3.getObject({Bucket: 'cloud-compile', Key: key}).createReadStream();
    await streamToFile(s3_stream, '/tmp/upload', true /* decompress */);

    var args = clang_cmd.split(' ');
    args.push('/tmp/upload', '-o', '/tmp/in');
    frontend_result = child_process.spawnSync('clang-12', args);
  } catch(error) {
    console.error("Error fetching file from S3 bucket: ", error);
    res.status(500).json({
      'type': 's3_read',
      'message': "Error fetching file from S3 bucket.",
    });
    next();
  }

  // split files and output to /tmp/(temp_dir name)/
  var temp_dir = uuid.v4();
  var split_result;
  try {
    fs.mkdirSync(`/tmp/${temp_dir}/`);
    
    split_result = child_process.spawnSync('split', ['/tmp/in', '-o', `/tmp/${temp_dir}/`, '-preserve-locals']);
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

    const files = fs.readdirSync(`/tmp/${temp_dir}/`); // read split files
    // generate params for each file
    files.forEach(file => {
      var s3_file_key = uuid.v4();
      var param = {
        Bucket: 'cloud-compile',
        Key: s3_file_key,
        Body: fs.readFileSync(`/tmp/${temp_dir}/` + file)
      };
      params.push(param);
      s3_keys.push(s3_file_key);
    });

    // push to s3 bucket
    await Promise.all(
      params.map(param => S3.upload(param).promise())
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
  res.status(200).json({
    's3_keys': s3_keys,
    'split_stdout': split_result.stdout,
    'split_stderr': split_result.stderr,
    'split_status': split_result.status,
    'frontend_stdout': frontend_result.stdout,
    'frontend_stdout': frontend_result.stderr,
    'frontend_stdout': frontend_result.status
  });
});

module.exports.handler = sls(app);
