// Simple API endpoint that needs pagination added
import express from 'express';

const router = express.Router();

interface User {
  id: number;
  name: string;
  email: string;
}

// In-memory store
const users: User[] = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
}));

// GET /users - returns ALL users (no pagination)
router.get('/users', (req, res) => {
  res.json(users);
});

// GET /users/:id
router.get('/users/:id', (req, res) => {
  const user = users.find((u) => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

export default router;
