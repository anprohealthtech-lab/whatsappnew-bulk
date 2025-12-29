/**
 * Initialize default chatbot configuration on server startup
 */

import { storage } from "./storage";

export async function initializeChatbotConfig() {
  const log = (msg: string) => console.log(`[InitChatbot] ${msg}`);
  
  try {
    log("Checking chatbot configuration...");
    
    // Check if config already exists
    const existingConfig = await storage.getChatbotConfig();
    
    if (existingConfig) {
      log("✅ Chatbot configuration already exists");
      log(`   Agent: ${existingConfig.agentName}`);
      log(`   Status: ${existingConfig.isActive === 'true' ? 'Active' : 'Inactive'}`);
      return;
    }

    // Create default configuration
    log("Creating default chatbot configuration...");
    
    const defaultConfig = {
      agentName: "AnPro Sales Assistant",
      triggerKeywords: [
        "Hello we are interested in LIMS, please connect with us",
        "LIMS",
        "Demo",
        "Price"
      ],
      ragBaseUrl: "https://tnfqq3vcirfyalnqzg3c4wwy.agents.do-ai.run",
      ragAccessKey: "abc@123",
      contextMessageCount: 5,
      isActive: true,
    };

    await storage.updateChatbotConfig(defaultConfig);
    
    log("✅ Default chatbot configuration created successfully");
    log(`   Agent: ${defaultConfig.agentName}`);
    log(`   Trigger keywords: ${defaultConfig.triggerKeywords.length} keywords`);
    log(`   RAG Endpoint: ${defaultConfig.ragBaseUrl}`);
    log(`   Context messages: ${defaultConfig.contextMessageCount}`);
    log(`   Status: Active`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log(`❌ Failed to initialize chatbot config: ${errorMessage}`);
    console.error(error);
  }
}
