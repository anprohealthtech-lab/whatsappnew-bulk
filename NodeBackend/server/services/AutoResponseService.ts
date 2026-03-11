import { storage } from '../storage';
import type { WhatsAppService } from './WhatsAppService';
import { log } from '../utils';

export class AutoResponseService {
  private whatsAppService: WhatsAppService | null = null;

  /** Set the WhatsApp service instance for sending responses */
  setWhatsAppService(service: WhatsAppService) {
    this.whatsAppService = service;
  }

  /**
   * Check if incoming message matches any keywords and send auto-response
   */
  async handleIncomingMessage(phoneNumber: string, messageText: string): Promise<boolean> {
    try {
      if (!this.whatsAppService) {
        log('AutoResponseService: No WhatsApp service set, skipping auto-response');
        return false;
      }

      const autoResponses = await storage.getAutoResponses();
      
      for (const response of autoResponses) {
        const keyword = response.keyword.toUpperCase();
        const msgUpper = messageText.trim().toUpperCase();
        
        // Check if message contains or matches the keyword
        if (msgUpper.includes(keyword) || msgUpper === keyword) {
          log(`🤖 Auto-responding to keyword "${keyword}" from ${phoneNumber}`);
          
          // Send auto-response
          await this.whatsAppService.sendTextMessage(phoneNumber, response.response);
          
          // Save auto-response to database
          await storage.createMessage({
            phoneNumber,
            content: response.response,
            type: 'text',
            status: 'sent',
          });

          return true; // Response sent
        }
      }
      
      return false; // No matching keyword
    } catch (error) {
      log(`Error handling auto-response: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }
}

export const autoResponseService = new AutoResponseService();
