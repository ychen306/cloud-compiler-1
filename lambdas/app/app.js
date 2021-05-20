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
  var compile_result;

  try {
    var args = clang_cmd.split(' ');
    args.push('/tmp/in', '-o', '-');
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

  // send base64 encoded object file back to user
  res.status(200).json({
    'data': Buffer.from(compile_result.stdout).toString('base64'),
    'stderr': compile_result.stderr,
    'status': compile_result.status
  });

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
  var data = req.body.data;
  const chunks = req.body.chunks;
  const compressed = req.body.compressed;
  const clang_cmd = req.body.clang_cmd;

  // write uploaded file to disk
  try {
    if(compressed) {
      data = zlib.inflateSync(data);
    }

    fs.writeFileSync('/tmp/upload', data);
    child_process.execSync(`clang-12 ${clang_cmd} /tmp/upload -o /tmp/in`)
  } catch(error) {
    console.error("Error writing data to lambda disk: ", error);
    res.status(500).json({
      'type': 'write_file',
      'message': "Error writing data to lambda disk."
    });
    next();
  }

  // split files and output to /tmp/(temp_dir name)/
  var temp_dir = uuid.v4();
  var split_result;
  try {
    fs.mkdirSync(`/tmp/${temp_dir}/`);
    
    split_result = child_process.spawnSync('llvm-split-12', [`-j${chunks}`, '/tmp/in', '-o', `/tmp/${temp_dir}/`]);
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
        Bucket: 'cloudcompilerbucket',
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
    'stdout': split_result.stdout,
    'stderr': split_result.stderr,
    'status': split_result.status
  });
});

module.exports.handler = sls(app);
