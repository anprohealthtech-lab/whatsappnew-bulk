import { getAuthToken } from '@/lib/AuthContext';

interface WhatsAppStatus {
  connected: boolean;
  phoneNumber?: string;
  lastConnected?: string;
  error?: string;
}

interface ConnectionResult {
  success: boolean;
  qrCode?: string;
  message?: string;
  error?: string;
}

class WhatsAppService {
  private baseUrl = '/api';

  async getStatus(): Promise<WhatsAppStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const data = await response.json();
      
      if (data.success) {
        return {
          connected: data.data?.whatsapp?.connected || false,
          phoneNumber: data.data?.whatsapp?.phoneNumber,
          lastConnected: data.data?.whatsapp?.lastConnected
        };
      }
      
      return { connected: false, error: data.message };
    } catch (error) {
      console.error('Failed to get WhatsApp status:', error);
      return { connected: false, error: 'Failed to check status' };
    }
  }

  async connect(): Promise<ConnectionResult> {
    try {
      const response = await fetch(`${this.baseUrl}/whatsapp/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
      });
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Failed to connect WhatsApp:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }

  async getQRCode(): Promise<{ success: boolean; qrCode?: string; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/generate-qr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
      });
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Failed to generate QR code:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate QR code'
      };
    }
  }

  async disconnect(): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/whatsapp/disconnect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Failed to disconnect WhatsApp:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Disconnect failed'
      };
    }
  }

  async sendMessage(phoneNumber: string, message: string, metadata?: any): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/send-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify({
          phoneNumber,
          content: message,
          type: 'text',
          metadata
        }),
      });
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Failed to send message:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send message'
      };
    }
  }
}

export const whatsAppService = new WhatsAppService();
export type { WhatsAppStatus, ConnectionResult };