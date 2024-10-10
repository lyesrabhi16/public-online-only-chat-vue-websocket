import { Server } from 'socket.io';


const io = new Server(3000, {
    cors: {
        origin: "*",
    }
});

const clients = new Set();

io.on("connection", (socket) => {
    clients.add(socket);
    console.log("New client connected");
    socket.emit("message", "Hello! Message from Server!!");

    socket.on("message", (message) => {
        console.log("Message from client ==>", message);
        clients.forEach((client) => {
            client.emit("message", message);
            if (client === socket) {
              client.emit("message-sent", message)
            }
        });
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected");
        clients.delete(socket);
    });
})