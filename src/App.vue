<script setup>
  import { onMounted } from 'vue'
  import { initFlowbite } from 'flowbite'
  import Navbar from './components/navigation/Navbar.vue'
  import { useMqttClient } from './services/mqttClient';
  import { Amplify } from 'aws-amplify';
  import amplifyConfig from './aws-exports';

  Amplify.configure(amplifyConfig);
  const mqttClient = useMqttClient();

  onMounted(() => {
    initFlowbite();
    mqttClient.startIfAuthenticated();
  })
</script>

<template>
  <div>
    <Navbar/>
    <RouterView/>
  </div>
</template>

