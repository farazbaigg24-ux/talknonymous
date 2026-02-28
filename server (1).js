const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Store waiting users: { socketId: { interests: [], socket } }
const waitingPool = new Map();
// Store active pairs: { socketId: partnerSocketId }
const activePairs = new Map();
// Store user data
const users = new Map();

function findMatch(socketId) {
  const user = users.get(socketId);
  if (!user) return null;

  for (const [waitingId, waitingUser] of waitingPool.entries()) {
    if (waitingId === socketId) continue;

    // Check interest overlap if both have interests
    let score = 0;
    if (user.interests.length > 0 && waitingUser.interests.length > 0) {
      const common = user.interests.filter(i => waitingUser.interests.includes(i));
      score = common.length;
    }

    return { id: waitingId, score };
  }
  return null;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Update online count
  io.emit('online-count', io.engine.clientsCount);

  socket.on('join', ({ interests }) => {
    users.set(socket.id, { interests: interests || [], socketId: socket.id });

    // Try to find a match
    const match = findMatch(socket.id);

    if (match) {
      // Remove match from waiting pool
      waitingPool.delete(match.id);

      // Create pair
      activePairs.set(socket.id, match.id);
      activePairs.set(match.id, socket.id);

      const room = `room_${socket.id}_${match.id}`;

      socket.join(room);
      io.sockets.sockets.get(match.id)?.join(room);

      // Notify both - one is initiator (makes the WebRTC offer)
      socket.emit('matched', { partnerId: match.id, room, isInitiator: true });
      io.to(match.id).emit('matched', { partnerId: socket.id, room, isInitiator: false });

    } else {
      // Add to waiting pool
      waitingPool.set(socket.id, users.get(socket.id));
      socket.emit('waiting');
    }
  });

  // WebRTC signaling relay
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // Chat message
  socket.on('chat-message', ({ message }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('chat-message', { message, from: 'stranger' });
    }
  });

  // Skip / Next
  socket.on('next', () => {
    disconnectPair(socket.id);
    // Re-queue
    socket.emit('searching');
  });

  // Report
  socket.on('report', ({ reason }) => {
    const partnerId = activePairs.get(socket.id);
    console.log(`User ${socket.id} reported ${partnerId} for: ${reason}`);
    // In production, log to database
    disconnectPair(socket.id);
    socket.emit('searching');
  });

  socket.on('disconnect', () => {
    disconnectPair(socket.id);
    waitingPool.delete(socket.id);
    users.delete(socket.id);
    io.emit('online-count', io.engine.clientsCount);
    console.log('User disconnected:', socket.id);
  });

  function disconnectPair(socketId) {
    const partnerId = activePairs.get(socketId);
    if (partnerId) {
      io.to(partnerId).emit('partner-disconnected');
      activePairs.delete(partnerId);
      activePairs.delete(socketId);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Talknonymous server running on port ${PORT}`);
});
