'use strict';

const path = require('path');
const { PassThrough } = require('stream');
const ftp = require('basic-ftp');
const { AuthRequiredError } = require('./http');

// FTP transport. Each connection is a separate control session; ranges are
// read with REST <offset> + RETR and the data socket is closed once the
// segment has what it needs, the same way multi-connection FTP clients work.

function remotePath(url) {
  return decodeURIComponent(new URL(url).pathname);
}

function connectOptions(url, creds) {
  const u = new URL(url);
  const implicit = u.protocol === 'ftps:';
  return {
    host: u.hostname,
    port: Number(u.port) || (implicit ? 990 : 21),
    user: creds?.username || 'anonymous',
    password: creds ? creds.password : 'anonymous@',
    secure: implicit ? 'implicit' : false,
  };
}

function mapError(err, creds) {
  const message = String(err?.message || err);
  if (/too many|maximum|limit|try again later/i.test(message) || err?.code === 421) {
    const busy = new Error(`FTP server refused another connection: ${message}`);
    busy.tooManyConnections = true;
    return busy;
  }
  if (err?.code === 530) {
    return new AuthRequiredError(
      null,
      creds ? 'FTP login failed: user name or password was rejected' : 'FTP server requires a login',
    );
  }
  if (err?.code === 550) {
    const notFound = new Error(`FTP: ${message}`);
    notFound.fatal = true;
    return notFound;
  }
  return err;
}

async function connect(url, creds, signal) {
  const client = new ftp.Client(30000);
  const onAbort = () => client.close();
  signal?.addEventListener('abort', onAbort, { once: true });
  const dispose = () => {
    signal?.removeEventListener('abort', onAbort);
    client.close();
  };
  try {
    await client.access(connectOptions(url, creds));
  } catch (err) {
    dispose();
    throw mapError(err, creds);
  }
  return { client, dispose };
}

async function probe(url, creds, signal) {
  const { client, dispose } = await connect(url, creds, signal);
  try {
    const file = remotePath(url);
    let totalBytes = null;
    try {
      totalBytes = await client.size(file);
    } catch (err) {
      if (err?.code === 550) throw mapError(err, creds);
      // SIZE unsupported: download as a single stream of unknown length.
    }
    return { totalBytes, resumable: totalBytes != null, fileName: path.posix.basename(file) };
  } finally {
    dispose();
  }
}

// Yields the file's bytes from `start`. Stopping the iteration closes the
// connection, which is how a segment ends before the end of the file.
async function* openRange(url, creds, start, signal) {
  const { client, dispose } = await connect(url, creds, signal);
  const stream = new PassThrough();
  let failure = null;
  const transfer = client.downloadTo(stream, remotePath(url), start).catch((err) => {
    failure = mapError(err, creds);
    stream.destroy(failure);
  });
  try {
    for await (const chunk of stream) yield chunk;
    await transfer;
    if (failure) throw failure;
  } finally {
    dispose();
  }
}

module.exports = { probe, openRange, remotePath };
