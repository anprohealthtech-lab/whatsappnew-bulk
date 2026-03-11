import { apiRequest } from './queryClient';
import { getAuthToken } from './AuthContext';

export interface MessageStats {
  totalMessages: number;
  sentToday: number;
  deliveredToday: number;
  failedToday: number;
  pendingCount: number;
}

export interface WhatsAppStatus {
  isConnected: boolean;
  isAuthenticated: boolean;
  lastSeen: string | null;
}

export interface SystemStatus {
  whatsapp: WhatsAppStatus;
  stats: MessageStats;
  systemLogs: any[];
  timestamp: string;
}

export interface Message {
  id: string;
  phoneNumber: string;
  content: string;
  type: string;
  status: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  sampleId?: string;
  createdAt: string;
  sentAt?: string;
  deliveredAt?: string;
}

export interface MessageHistoryResponse {
  messages: Message[];
  total: number;
  limit: number;
  offset: number;
}

export const api = {
  // Send text message
  sendMessage: async (phoneNumber: string, content: string) => {
    const response = await apiRequest('POST', '/api/send-message', {
      phoneNumber,
      content,
    });
    return response.json();
  },

  // Send report with file
  sendReport: async (phoneNumber: string, sampleId: string, file: File, content?: string) => {
    const formData = new FormData();
    formData.append('phoneNumber', phoneNumber);
    formData.append('sampleId', sampleId);
    formData.append('file', file);
    if (content) {
      formData.append('content', content);
    }

    const response = await fetch('/api/send-report', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || response.statusText);
    }

    return response.json();
  },

  // Get system status
  getStatus: async (): Promise<SystemStatus> => {
    const response = await apiRequest('GET', '/api/status');
    const result = await response.json();
    return result.data;
  },

  // Get message history
  getMessages: async (params?: {
    status?: string;
    phoneNumber?: string;
    type?: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<MessageHistoryResponse> => {
    const searchParams = new URLSearchParams();
    
    if (params?.status) searchParams.append('status', params.status);
    if (params?.phoneNumber) searchParams.append('phoneNumber', params.phoneNumber);
    if (params?.type) searchParams.append('type', params.type);
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.offset) searchParams.append('offset', params.offset.toString());
    if (params?.search) searchParams.append('search', params.search);

    const url = `/api/messages${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
    const response = await apiRequest('GET', url);
    const result = await response.json();
    return result.data;
  },

  // Generate QR code
  generateQR: async () => {
    const response = await apiRequest('POST', '/api/generate-qr');
    return response.json();
  },

  // Resend message
  resendMessage: async (messageId: string) => {
    const response = await apiRequest('POST', `/api/messages/${messageId}/resend`);
    return response.json();
  },

  // Get system logs
  getLogs: async (params?: { limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    
    if (params?.limit) searchParams.append('limit', params.limit.toString());
    if (params?.offset) searchParams.append('offset', params.offset.toString());

    const url = `/api/logs${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
    const response = await apiRequest('GET', url);
    const result = await response.json();
    return result.data;
  },

  // Generic HTTP methods
  post: async (url: string, data: any) => {
    const response = await apiRequest('POST', url, data);
    return response.json();
  },

  put: async (url: string, data: any) => {
    const response = await apiRequest('PUT', url, data);
    return response.json();
  },

  delete: async (url: string) => {
    const response = await apiRequest('DELETE', url);
    return response.json();
  },
};
