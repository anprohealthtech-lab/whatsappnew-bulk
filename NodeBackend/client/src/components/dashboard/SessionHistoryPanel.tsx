import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Activity,
  Wifi,
  WifiOff,
  RefreshCw,
  Loader2,
  AlertTriangle,
  QrCode,
  Clock,
} from "lucide-react";

interface HistoryEntry {
  id: string;
  userId: string;
  sessionName: string;
  event: string;
  reason: string | null;
  statusCode: number | null;
  phoneNumber: string | null;
  sessionDurationSeconds: number | null;
  metadata: any;
  createdAt: string;
}

interface Session {
  sessionName: string;
  status: string;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function eventBadge(event: string) {
  switch (event) {
    case "connected":
      return <Badge className="bg-green-100 text-green-800 hover:bg-green-100"><Wifi className="w-3 h-3 mr-1" /> Connected</Badge>;
    case "disconnected":
      return <Badge variant="destructive"><WifiOff className="w-3 h-3 mr-1" /> Disconnected</Badge>;
    case "reconnecting":
      return <Badge className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100"><RefreshCw className="w-3 h-3 mr-1" /> Reconnecting</Badge>;
    case "auth_failure":
      return <Badge className="bg-red-100 text-red-800 hover:bg-red-100"><AlertTriangle className="w-3 h-3 mr-1" /> Auth Failed</Badge>;
    case "qr_pending":
      return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100"><QrCode className="w-3 h-3 mr-1" /> QR Pending</Badge>;
    default:
      return <Badge variant="secondary">{event}</Badge>;
  }
}

export function SessionHistoryPanel() {
  const [selectedSession, setSelectedSession] = useState<string>("all");

  const { data: sessions = [] } = useQuery<Session[]>({
    queryKey: ["/api/whatsapp/sessions"],
  });

  const { data: history = [], isLoading, refetch } = useQuery<HistoryEntry[]>({
    queryKey: ["/api/whatsapp/session/history", selectedSession],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (selectedSession && selectedSession !== "all") {
        params.set("sessionName", selectedSession);
      }
      const res = await apiRequest("GET", `/api/whatsapp/session/history?${params}`);
      return res.json();
    },
    refetchInterval: 30000,
  });

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              Session Connection History
            </CardTitle>
            <div className="flex items-center gap-2">
              <Select value={selectedSession} onValueChange={setSelectedSession}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All sessions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sessions</SelectItem>
                  {sessions.map((s) => (
                    <SelectItem key={s.sessionName} value={s.sessionName}>
                      {s.sessionName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={() => refetch()}>
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : history.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">
              No connection events recorded yet. Events will appear once a session connects or disconnects.
            </p>
          ) : (
            <div className="space-y-2">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start justify-between p-3 rounded-lg border bg-card/50 hover:bg-accent/30 transition-colors"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5">
                      {eventBadge(entry.event)}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{entry.sessionName}</span>
                        {entry.phoneNumber && (
                          <span className="text-xs text-muted-foreground">
                            +{entry.phoneNumber}
                          </span>
                        )}
                      </div>
                      {entry.reason && (
                        <p className="text-xs text-muted-foreground">
                          Reason: <span className="font-mono">{entry.reason}</span>
                          {entry.statusCode != null && (
                            <span className="ml-1 opacity-70">(code {entry.statusCode})</span>
                          )}
                        </p>
                      )}
                      {entry.sessionDurationSeconds != null && entry.sessionDurationSeconds > 0 && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Session lasted {formatDuration(entry.sessionDurationSeconds)}
                        </p>
                      )}
                      {entry.metadata && entry.event === "connected" && entry.metadata.waVersion && (
                        <p className="text-xs text-muted-foreground">
                          WA v{Array.isArray(entry.metadata.waVersion) ? entry.metadata.waVersion.join('.') : entry.metadata.waVersion}
                        </p>
                      )}
                      {entry.metadata && entry.event === "reconnecting" && entry.metadata.attempt && (
                        <p className="text-xs text-muted-foreground">
                          Attempt {entry.metadata.attempt}/{entry.metadata.maxAttempts}
                        </p>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap ml-4">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
