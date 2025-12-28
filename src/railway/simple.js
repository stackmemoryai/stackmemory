import express from 'express';
import cors from 'cors';
import { createServer } from 'http';

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    port: port
  });
});

// Basic API endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: 'StackMemory Railway Server is running!',
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
const server = createServer(app);
server.listen(port, '0.0.0.0', () => {
  console.log(`
🚂 StackMemory Simple Server Started
=====================================
Environment: ${process.env.NODE_ENV || 'development'}
Port: ${port}
Health: http://localhost:${port}/health
=====================================
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});