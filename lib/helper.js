'use strict';

function configureGracefulShutdown(server) {
    let nextConnectionId = 0;
    const connections = [];
    let terminating = false;
  
    server.on('connection', connection => {
      const connectionId = nextConnectionId++;
      connection.$$isIdle = true;
      connections[connectionId] = connection;
      connection.on('close', () => delete connections[connectionId]);
    });
  
    server.on('request', (request, response) => {
      const connection = request.connection;
      connection.$$isIdle = false;
  
      response.on('finish', () => {
        connection.$$isIdle = true;
        if (terminating) {
          connection.destroy();
        }
      });
    });
  
    const handleShutdown = () => {
      console.log("Shutting down..");
  
      terminating = true;
      server.close(() => console.log("Server stopped"));
  
      for (const connectionId in connections) {
        if (connections.hasOwnProperty(connectionId)) {
          const connection = connections[connectionId];
          if (connection.$$isIdle) {
            connection.destroy();
          }
        }
      }
    };
  
    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);
  }

  module.exports = {
    configureGracefulShutdown
  };