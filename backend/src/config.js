export function getServerConfig(env = process.env) {
  const parsedPort = Number(env.LOCAL_GIT_PORT || 3000);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error('LOCAL_GIT_PORT must be a valid TCP port number.');
  }
  return Object.freeze({ port: parsedPort, host: '127.0.0.1', nodeEnv: env.NODE_ENV || 'development' });
}
