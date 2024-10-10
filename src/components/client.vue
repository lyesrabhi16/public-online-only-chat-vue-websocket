<script setup lang="ts">
    import { ref, onMounted } from 'vue';
    import { io } from 'socket.io-client';
    const messages = ref<string[]>([]);
    let socket; 
    const addMessage = (message: string) => {
        console.log('Adding message:', message);
        
        messages.value = [...messages.value, message];
    };

    const handleSubmit = (event: Event) => {
        event.preventDefault();
        const input = document.getElementById('send_message') as HTMLInputElement;
        if (socket){
            socket.emit('message', input.value);
            input.value = '';
        }
    };

    onMounted(()=> {
        socket = io('ws://localhost:3000');
        socket.on('connect', () => {
            console.log('Connected to server');
        });
        socket.on('message', (message: string) => {
            addMessage(message);
        });
        socket.on('disconnect', () => {
            console.log('Disconnected from server');
        });
    });

</script>

<template>
    
    <ul>
        <li v-for="message in messages" :key="message">{{ message }}</li>
    </ul>
    <form @submit="handleSubmit">
        <input id="send_message" type="text" />
        <button type="submit">Add</button>
    </form>
</template>

<style scoped>
    ul {
        list-style-type: none;
        padding: 0;
    }
</style>
