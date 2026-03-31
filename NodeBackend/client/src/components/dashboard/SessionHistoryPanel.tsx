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
  Database,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  Zap,
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
    case "force_fresh_pairing":
      return <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-100"><ShieldAlert className="w-3 h-3 mr-1" /> Fresh Pairing</Badge>;
    default:
      return <Badge variant="secondary">{event}</Badge>;
  }
}

function DiagnosticsPanel({ metadata }: { metadata: any }) {
  if (!metadata) return null;

  const hasDbIssues = (metadata.dbWriteFailures || 0) > 0 || (metadata.dbReadFailures || 0) > 0;
  const hasSlowQueries = (metadata.dbSlowQueries || 0) > 0;
  const dbNotHealthy = metadata.dbHealthy === false;

  return (
    <div className="mt-2 space-y-2">
      {/* DB Health Summary */}
      {(hasDbIssues || dbNotHealthy || hasSlowQueries) && (
        <div className={`rounded-md p-2 text-xs ${dbNotHealthy ? 'bg-red-50 border border-red-200' : hasDbIssues ? 'bg-orange-50 border border-orange-200' : 'bg-yellow-50 border border-yellow-200'}`}>
          <div className="flex items-center gap-1 font-semibold mb-1">
            <Database className="w-3 h-3" />
            {dbNotHealthy ? '🔴 DB Connection Down' : hasDbIssues ? '🟠 DB Write/Read Failures Detected' : '🟡 Slow DB Queries'}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
            {metadata.dbWriteFailures != null && (
              <span className={metadata.dbWriteFailures > 0 ? 'text-red-700 font-semibold' : ''}>
                Write failures: {metadata.dbWriteFailures}
              </span>
            )}
            {metadata.dbReadFailures != null && (
              <span className={metadata.dbReadFailures > 0 ? 'text-red-700 font-semibold' : ''}>
                Read failures: {metadata.dbReadFailures}
              </span>
            )}
            {metadata.dbSlowQueries != null && (
              <span className={metadata.dbSlowQueries > 0 ? 'text-yellow-700' : ''}>
                Slow queries: {metadata.dbSlowQueries}
              </span>
            )}
            {metadata.dbKeyCount != null && (
              <span>Auth keys in DB: {metadata.dbKeyCount}</span>
            )}
          </div>
          {metadata.dbLastWriteFailure && (
            <div className="mt-1 text-red-700">
              Last write failure: <span className="font-mono">{metadata.dbLastWriteFailure.category}/{metadata.dbLastWriteFailure.keyId}</span>
              {' — '}{metadata.dbLastWriteFailure.error}
              {' @ '}{new Date(metadata.dbLastWriteFailure.at).toLocaleTimeString()}
            </div>
          )}
          {metadata.dbLastReadFailure && (
            <div className="mt-1 text-red-700">
              Last read failure: <span className="font-mono">{metadata.dbLastReadFailure.category}/{metadata.dbLastReadFailure.keyId}</span>
              {' — '}{metadata.dbLastReadFailure.error}
              {' @ '}{new Date(metadata.dbLastReadFailure.at).toLocaleTimeString()}
            </div>
          )}
        </div>
      )}

      {/* Connection State Details */}
      <div className="rounded-md bg-muted/50 p-2 text-xs">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5">
          {metadata.code != null && (
            <span>Disconnect code: <span className="font-mono font-semibold">{metadata.code}</span> ({metadata.reasonLabel || 'unknown'})</span>
          )}
          {metadata.fullErrorMessage && (
            <span className="col-span-2 sm:col-span-3 text-red-600 font-mono break-all">
              Error: {metadata.fullErrorMessage}
            </span>
          )}
          {metadata.restoredFromStoredCreds != null && (
            <span>Restored from DB: {metadata.restoredFromStoredCreds ? 'Yes' : 'No'}</span>
          )}
          {metadata.reconnectAttempts != null && (
            <span>Reconnect attempts: {metadata.reconnectAttempts}</span>
          )}
          {metadata.badSessionRetryCount != null && metadata.badSessionRetryCount > 0 && (
            <span className="text-orange-700 font-semibold">Bad session retries: {metadata.badSessionRetryCount}</span>
          )}
          {metadata.isPairing != null && (
            <span>Pairing mode: {metadata.isPairing ? 'Yes' : 'No'}</span>
          )}
          {metadata.dbCredsWriteCount != null && (
            <span>Creds saved: {metadata.dbCredsWriteCount}x</span>
          )}
          {metadata.dbLastCredsWrite && (
            <span>Last creds save: {new Date(metadata.dbLastCredsWrite).toLocaleTimeString()}</span>
          )}
          {metadata.dbHealthy != null && (
            <span className={metadata.dbHealthy ? 'text-green-700' : 'text-red-700 font-semibold'}>
              DB health: {metadata.dbHealthy ? '✓ OK' : '✗ FAILED'}
            </span>
          )}
          {metadata.dbKeyCount != null && !hasDbIssues && !dbNotHealthy && (
            <span>Auth keys: {metadata.dbKeyCount}</span>
          )}
        </div>

        {/* Key breakdown */}
        {metadata.dbKeysByCategory && Object.keys(metadata.dbKeysByCategory).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {Object.entries(metadata.dbKeysByCategory).map(([cat, count]) => (
              <span key={cat} className="inline-flex items-center rounded bg-background px-1.5 py-0.5 font-mono text-[10px] border">
                {cat}: {String(count)}
              </span>
            ))}
          </div>
        )}

        {/* WA version info */}
        {metadata.waVersion && (
          <div className="mt-1">
            WA v{Array.isArray(metadata.waVersion) ? metadata.waVersion.join('.') : metadata.waVersion}
            {metadata.browser && <span className="ml-2">Browser: {metadata.browser}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionHistoryPanel() {
  const [selectedSession, setSelectedSession] = useState<string>("all");
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
              {history.map((entry) => {
                const hasMetadata = entry.metadata && typeof entry.metadata === 'object' && Object.keys(entry.metadata).length > 0;
                const isExpanded = expandedEntries.has(entry.id);
                const hasDbIssues = hasMetadata && ((entry.metadata.dbWriteFailures || 0) > 0 || (entry.metadata.dbReadFailures || 0) > 0 || entry.metadata.dbHealthy === false);

                return (
                <div
                  key={entry.id}
                  className={`p-3 rounded-lg border bg-card/50 hover:bg-accent/30 transition-colors ${hasDbIssues ? 'border-orange-300 bg-orange-50/30' : ''}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className="mt-0.5">
                        {eventBadge(entry.event)}
                      </div>
                      <div className="min-w-0 space-y-1 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{entry.sessionName}</span>
                          {entry.phoneNumber && (
                            <span className="text-xs text-muted-foreground">
                              +{entry.phoneNumber}
                            </span>
                          )}
                          {hasDbIssues && (
                            <Badge variant="outline" className="text-orange-700 border-orange-300 text-[10px] px-1.5 py-0">
                              <Database className="w-2.5 h-2.5 mr-0.5" /> DB Issues
                            </Badge>
                          )}
                          {entry.metadata?.badSessionRetryCount > 0 && (
                            <Badge variant="outline" className="text-purple-700 border-purple-300 text-[10px] px-1.5 py-0">
                              <Zap className="w-2.5 h-2.5 mr-0.5" /> Retry #{entry.metadata.badSessionRetryCount}
                            </Badge>
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
                        {/* Quick summary for reconnecting entries */}
                        {entry.metadata && entry.event === "reconnecting" && entry.metadata.attempt && (
                          <p className="text-xs text-muted-foreground">
                            Attempt {entry.metadata.attempt}/{entry.metadata.maxAttempts}
                            {entry.metadata.dbWriteFailures > 0 && (
                              <span className="text-orange-600 ml-2">⚠ {entry.metadata.dbWriteFailures} DB write failures</span>
                            )}
                          </p>
                        )}
                        {/* Quick summary for connected entries */}
                        {entry.metadata && entry.event === "connected" && (
                          <p className="text-xs text-muted-foreground">
                            {entry.metadata.waVersion && `WA v${Array.isArray(entry.metadata.waVersion) ? entry.metadata.waVersion.join('.') : entry.metadata.waVersion}`}
                            {entry.metadata.restoredFromStored != null && (
                              <span className="ml-2">{entry.metadata.restoredFromStored ? '(restored from DB)' : '(fresh pairing)'}</span>
                            )}
                            {entry.metadata.dbKeyCount != null && (
                              <span className="ml-2">Keys: {entry.metadata.dbKeyCount}</span>
                            )}
                          </p>
                        )}

                        {/* Expandable diagnostics */}
                        {hasMetadata && (
                          <button
                            onClick={() => toggleExpanded(entry.id)}
                            className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary mt-1"
                          >
                            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            {isExpanded ? 'Hide diagnostics' : 'Show diagnostics'}
                          </button>
                        )}
                        {isExpanded && <DiagnosticsPanel metadata={entry.metadata} />}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap ml-4">
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
