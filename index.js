const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);



app.use(express.static('public'));

// Update 2: Use Environment Variable for the database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // This is REQUIRED for Render/Railway
    }
});

const initDb = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS rooms (id SERIAL PRIMARY KEY, room_name TEXT UNIQUE NOT NULL, user_limit INTEGER DEFAULT 10);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, username TEXT NOT NULL, message_text TEXT NOT NULL, room TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        console.log("Postgres Tables Ready! ✅");
    } catch (err) { console.error("DB Init Error:", err); }
};
initDb();

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

async function destroyRoom(roomName) {
    try {
        await pool.query('DELETE FROM messages WHERE room = $1', [roomName]);
        await pool.query('DELETE FROM rooms WHERE room_name = $1', [roomName]);
        console.log(`Room ${roomName} auto-deleted.`);
    } catch (err) { console.error("Cleanup error:", err); }
}

let roomTimers = {}; 

// Helper for formatted time
const getTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

io.on('connection', (socket) => {
    socket.on('delete account', async (username) => {
        try {
            await pool.query('DELETE FROM users WHERE username = $1', [username]);
            socket.emit('account deleted');
            console.log('Account deleted sucessful'); 

        } catch (e) { socket.emit('error message', 'Delete failed.'); }
    });

    socket.on('delete room', async (roomName) => {
        await destroyRoom(roomName);
        io.to(roomName).emit('room kicked');
    });

    socket.on('register', async ({ user, pass }) => {
        try {
            await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [user, pass]);
            socket.emit('auth-success', user);
        } catch (e) { socket.emit('error message', 'Username taken!'); }
    });

    socket.on('login', async ({ user, pass }) => {
        const res = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [user, pass]);
        if (res.rows.length > 0) { socket.emit('auth-success', user); } 
        else { socket.emit('error message', 'Invalid credentials!'); }
    });

    socket.on('create room', async ({ roomName, limit }) => {
        try {
            await pool.query('INSERT INTO rooms (room_name, user_limit) VALUES ($1, $2)', [roomName, limit]);
            socket.emit('room-created', {roomName, time: getTime()});
        } catch (e) { socket.emit('error message', 'Room exists!'); }
    });

    socket.on('join room', async ({ username, room }) => {
        const roomRes = await pool.query('SELECT * FROM rooms WHERE room_name = $1', [room]);
        if (roomRes.rows.length === 0) return socket.emit('error message', 'Room not found!');

        if (roomTimers[room]) {
            clearTimeout(roomTimers[room]);
            delete roomTimers[room];
        }

        socket.join(room);
        socket.username = username;
        socket.room = room;
        socket.emit('room joined', room);

        const history = await pool.query(`
            SELECT username AS user, message_text AS text, 
            to_char(created_at, 'HH12:MI AM') as time 
            FROM messages WHERE room = $1 ORDER BY created_at DESC LIMIT 20`, [room]);
        
        socket.emit('load history', history.rows.reverse());
        io.to(room).emit('chat message', { user: 'System', text: `${username} joined.`, time: getTime() });
    });

    socket.on('chat message', async (data) => {
        if (!socket.room) return;
        const time = getTime();
        await pool.query('INSERT INTO messages (username, message_text, room) VALUES ($1, $2, $3)', [data.user, data.text, socket.room]);
        io.to(socket.room).emit('chat message', { user: data.user, text: data.text, time: time });
    });

    // --- TYPING LOGIC ---
    socket.on('typing', (data) => {
        socket.to(data.room).emit('typing', { user: data.user });
    });

    socket.on('stop typing', (data) => {
        socket.to(data.room).emit('stop typing');
    });

    socket.on('disconnect', () => {
        if (socket.room) {
            io.to(socket.room).emit('chat message', { user: 'System', text: `${socket.username} left.`, time: getTime() });
            const roomData = io.sockets.adapter.rooms.get(socket.room);
            if (!roomData || roomData.size === 0) {
                roomTimers[socket.room] = setTimeout(() => { destroyRoom(socket.room); }, 300000); 
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
    console.log(`🚀 Server alive at port ${PORT}`); 
});