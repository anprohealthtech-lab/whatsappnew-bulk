import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';

interface SocketMessage {
  type: string;
  data: any;
}

export function useSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [whatsappStatus, setWhatsappStatus] = useState({
    isConnected: false,
    isAuthenticated: false,
    lastSeen: null,
  });
  const [qrCode, setQrCode] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const { toast } = useToast();

  const connect = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    socketRef.current = new WebSocket(wsUrl);

    socketRef.current.onopen = () => {
      setIsConnected(true);
      console.log('WebSocket connected');
    };

    socketRef.current.onclose = () => {
      setIsConnected(false);
      console.log('WebSocket disconnected');
      
      // Attempt to reconnect after 3 seconds
      setTimeout(() => {
        if (!socketRef.current || socketRef.current.readyState === WebSocket.CLOSED) {
          connect();
        }
      }, 3000);
    };

    socketRef.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setIsConnected(false);
    };

    socketRef.current.onmessage = (event) => {
      try {
        const message: SocketMessage = JSON.parse(event.data);
        handleSocketMessage(message);
      } catch (error) {
        console.error('Failed to parse socket message:', error);
      }
    };
  };

  const handleSocketMessage = (message: SocketMessage) => {
    switch (message.type) {
      case 'whatsapp-status':
        setWhatsappStatus(message.data.status || message.data);
        break;
        
      case 'whatsapp-authenticated':
        setWhatsappStatus(message.data.status);
        setQrCode(null);
        toast({
          title: "WhatsApp Connected",
          description: "WhatsApp has been successfully authenticated",
        });
        break;
        
      case 'whatsapp-auth-failure':
        toast({
          title: "Authentication Failed",
          description: message.data.error || "Failed to authenticate WhatsApp",
          variant: "destructive",
        });
        break;
        
      case 'qr-code':
        console.log('QR Code received via WebSocket:', message.data.qr ? 'Yes' : 'No');
        setQrCode(message.data.qr);
        toast({
          title: "QR Code Generated",
          description: "Scan the QR code with WhatsApp on your phone",
        });
        break;
        
      case 'disconnected':
        // If shouldReconnect is true, this is a transient reconnect (e.g. WA server rotation)
        // Don't flash "Disconnected" in the UI — the session will auto-recover in seconds
        if (!message.data.shouldReconnect) {
          setWhatsappStatus({
            isConnected: false,
            isAuthenticated: false,
            lastSeen: null,
          });
          toast({
            title: "WhatsApp Disconnected",
            description: message.data.reason || "WhatsApp connection lost",
            variant: "destructive",
          });
        }
        break;
        
      case 'message-sent':
        toast({
          title: "Message Sent",
          description: "Your message has been sent successfully",
        });
        break;
        
      case 'message-update':
        if (message.data.ack === 3) {
          toast({
            title: "Message Delivered",
            description: "Your message has been delivered",
          });
        }
        break;
        
      default:
        console.log('Unknown socket message type:', message.type);
    }
  };

  useEffect(() => {
    connect();

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  return {
    isConnected,
    whatsappStatus,
    qrCode,
    setQrCode,
  };
}
