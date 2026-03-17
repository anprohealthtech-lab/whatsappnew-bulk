import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import {
  Smartphone,
  Wifi,
  WifiOff,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  ShieldAlert,
  AlertTriangle,
} from "lucide-react";

interface Session {
  sessionName: string;
  status: string;
  connectedAt?: string;
}

type ActiveQR = {
  sessionName: string;
  qr: string | null;
  qrCode?: string | null;
  rawQR?: string | null;
};

export function WhatsAppSessionPanel() {
  const [newSessionName, setNewSessionName] = useState("default");
  const [activeQR, setActiveQR] = useState<ActiveQR>({ sessionName: "", qr: null, qrCode: null, rawQR: null });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: sessions = [], isLoading } = useQuery<Session[]>({
    queryKey: ["/api/whatsapp/sessions"],
    refetchInterval: 10000,
  });

  // Fetch version info from the first connected session
  const connectedSession = sessions.find(s => s.status === "connected");
  const { data: versionInfo } = useQuery<{ waVersion?: number[]; waIsLatest?: boolean }>({
    queryKey: ["/api/whatsapp/session/status", connectedSession?.sessionName],
    queryFn: async () => {
      if (!connectedSession) return {};
      const res = await apiRequest("GET", `/api/whatsapp/session/status?sessionName=${encodeURIComponent(connectedSession.sessionName)}`);
      return res.json();
    },
    enabled: !!connectedSession,
    staleTime: 60000,
  });

  const initMutation = useMutation({
    mutationFn: async (sessionName: string) => {
      const res = await apiRequest("POST", "/api/whatsapp/session/init", { sessionName });
      return res.json();
    },
    onSuccess: (_, sessionName) => {
      toast({ title: "Session Initializing", description: `Session "${sessionName}" is connecting...` });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/sessions"] });
      pollQR(sessionName);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: async (sessionName: string) => {
      const res = await apiRequest("POST", "/api/whatsapp/session/disconnect", { sessionName });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Disconnected" });
      setActiveQR({ sessionName: "", qr: null, qrCode: null, rawQR: null });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/sessions"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const clearSessionsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/whatsapp/clear-sessions");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Signal Sessions Cleared", description: data.message || `Cleared ${data.cleared} files. Reconnecting...` });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/sessions"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  async function pollQR(sessionName: string) {
    const buildQrFromRaw = (rawQR: string) =>
      `https://quickchart.io/qr?size=512&margin=4&ecLevel=M&text=${encodeURIComponent(rawQR)}`;

    let attempts = 0;
    const poll = async () => {
      if (attempts > 30) return;
      attempts++;
      try {
        const res = await apiRequest("GET", `/api/whatsapp/session/qr?sessionName=${encodeURIComponent(sessionName)}`);
        const data = await res.json();
        const qrCode = data.qrCode || data.qr || null;
        const rawQR = data.rawQR || null;
        const qr = qrCode || (rawQR ? buildQrFromRaw(rawQR) : null);
        if (qr) {
          setActiveQR({ sessionName, qr, qrCode, rawQR });
        } else {
          // Check status
          const statusRes = await apiRequest("GET", `/api/whatsapp/session/status?sessionName=${encodeURIComponent(sessionName)}`);
          const status = await statusRes.json();
          if (status.isConnected) {
            setActiveQR({ sessionName: "", qr: null, qrCode: null, rawQR: null });
            queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/sessions"] });
            return;
          }
          setTimeout(poll, 3000);
        }
      } catch {
        setTimeout(poll, 3000);
      }
    };
    setTimeout(poll, 2000);
  }

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-primary" />
            WhatsApp Sessions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* New Session */}
          <div className="flex gap-2">
            <Input
              value={newSessionName}
              onChange={(e) => setNewSessionName(e.target.value)}
              placeholder="Session name"
              className="max-w-xs"
            />
            <Button
              onClick={() => initMutation.mutate(newSessionName)}
              disabled={!newSessionName.trim() || initMutation.isPending || sessions.length >= 3}
            >
              {initMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
              Connect
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {sessions.length}/3 sessions used. Each session connects a different WhatsApp number.
          </p>

          {/* Fix "waiting for this message" */}
          {sessions.some(s => s.status === "connected") && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => clearSessionsMutation.mutate()}
              disabled={clearSessionsMutation.isPending}
              className="text-orange-600 border-orange-300 hover:bg-orange-50"
            >
              {clearSessionsMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldAlert className="w-4 h-4 mr-2" />}
              Fix "Waiting for Message"
            </Button>
          )}

          {/* WhatsApp Version Warning */}
          {versionInfo?.waVersion && (
            <Alert variant={versionInfo.waIsLatest === false ? "destructive" : "default"} className={versionInfo.waIsLatest === false ? "" : "border-green-300 bg-green-50 text-green-800"}>
              {versionInfo.waIsLatest === false ? (
                <AlertTriangle className="h-4 w-4" />
              ) : (
                <Smartphone className="h-4 w-4" />
              )}
              <AlertDescription className="text-xs">
                {versionInfo.waIsLatest === false ? (
                  <>
                    <strong>Outdated WhatsApp version detected:</strong> v{versionInfo.waVersion.join('.')} — An older version is being used, which increases the risk of being banned during bulk sends. Please update the Baileys library.
                  </>
                ) : (
                  <>WhatsApp version: <strong>v{versionInfo.waVersion.join('.')}</strong> — up to date.</>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* QR Code Display */}
          {activeQR.qr && (
            <Card className="max-w-sm mx-auto">
              <CardContent className="p-6 text-center">
                <p className="text-sm text-muted-foreground mb-3">
                  Scan QR for session: <strong>{activeQR.sessionName}</strong>
                </p>
                <div className="bg-white p-4 rounded-xl inline-block shadow-sm">
                  <img
                    src={activeQR.qr}
                    alt="QR Code"
                    className="w-72 h-72 max-w-full"
                    style={{ imageRendering: "pixelated" }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-3">Open WhatsApp &gt; Linked Devices &gt; Link a Device</p>
              </CardContent>
            </Card>
          )}

          {/* Sessions List */}
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No sessions. Create one above.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div
                  key={s.sessionName}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card/50"
                >
                  <div className="flex items-center gap-3">
                    {s.status === "connected" ? (
                      <Wifi className="w-4 h-4 text-green-500" />
                    ) : (
                      <WifiOff className="w-4 h-4 text-red-400" />
                    )}
                    <div>
                      <p className="font-medium text-sm">{s.sessionName}</p>
                      {s.connectedAt && (
                        <p className="text-xs text-muted-foreground">
                          Since {new Date(s.connectedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={s.status === "connected" ? "default" : "secondary"}>
                      {s.status}
                    </Badge>
                    {s.status === "connected" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => disconnectMutation.mutate(s.sessionName)}
                        disabled={disconnectMutation.isPending}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    )}
                    {s.status !== "connected" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          initMutation.mutate(s.sessionName);
                        }}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
