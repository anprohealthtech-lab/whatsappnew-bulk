import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Clock,
  CalendarDays,
  Loader2,
  Play,
} from "lucide-react";

interface Campaign {
  id: string;
  name: string;
  originalMessage: string;
  variationMessage?: string;
}

interface Schedule {
  id: string;
  campaignId: string;
  variationMessage: string;
  scheduledAt: string;
  status: string;
  intervalSeconds?: number;
  jitterSeconds?: number;
}

interface LiveCampaignRun {
  campaignId: string;
  campaignName: string;
  status: string;
  total: number;
  processed: number;
  pending: number;
  sent: number;
  failed: number;
  startedAt: string;
  updatedAt: string;
  lastContactName?: string;
  lastContactPhone?: string;
  error?: string;
}

export function ScheduleCampaignPanel() {
  const [showSchedule, setShowSchedule] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState("10");
  const [jitterSeconds, setJitterSeconds] = useState("5");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
    select: (data: any) => data?.data || data || [],
  });

  const { data: schedules = [], isLoading } = useQuery<Schedule[]>({
    queryKey: ["/api/campaign-schedules"],
    select: (data: any) => data?.data || data || [],
    refetchInterval: 30000,
  });

  const { data: liveRuns = [] } = useQuery<LiveCampaignRun[]>({
    queryKey: ["/api/campaign-runs"],
    select: (data: any) => data?.data || data || [],
    refetchInterval: 5000,
  });

  const cancelMutation = useMutation({
    mutationFn: async (scheduleId: string) => {
      const res = await apiRequest("POST", `/api/campaign-schedules/${scheduleId}/cancel`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Schedule cancelled" });
      queryClient.invalidateQueries({ queryKey: ["/api/campaign-schedules"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const scheduleMutation = useMutation({
    mutationFn: async () => {
      const campaign = campaigns.find((c) => c.id === selectedCampaign);
      if (!campaign) throw new Error("Select a campaign");
      if (!scheduleDate || !scheduleTime) throw new Error("Set date and time");

      const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}`).toISOString();

      const res = await apiRequest("POST", `/api/campaigns/${selectedCampaign}/schedule`, {
        variation_message: campaign.variationMessage || campaign.originalMessage,
        scheduledAt,
        intervalSeconds: parseInt(intervalSeconds) || 10,
        jitterSeconds: parseInt(jitterSeconds) || 5,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Campaign Scheduled" });
      setShowSchedule(false);
      setSelectedCampaign("");
      setScheduleDate("");
      setScheduleTime("");
      queryClient.invalidateQueries({ queryKey: ["/api/campaign-schedules"] });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  function getStatusColor(status: string) {
    switch (status) {
      case "pending": return "secondary";
      case "running": return "default";
      case "completed": return "outline";
      case "stopped": return "secondary";
      case "failed": return "destructive";
      default: return "secondary";
    }
  }

  const visibleLiveRuns = liveRuns.filter((run) => {
    if (run.status === "running") return true;
    return Date.now() - new Date(run.updatedAt).getTime() < 15 * 60 * 1000;
  });

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Scheduled Campaigns
          </CardTitle>
          <Button onClick={() => setShowSchedule(true)} size="sm" disabled={campaigns.length === 0}>
            <CalendarDays className="w-4 h-4 mr-2" /> Schedule
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : schedules.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No scheduled campaigns. {campaigns.length === 0 ? "Create a campaign first." : "Schedule one above."}
            </p>
          ) : (
            <div className="space-y-3">
              {schedules.map((s) => (
                <div key={s.id} className="flex items-center justify-between p-4 rounded-lg border bg-card/50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">Campaign: {s.campaignId.slice(0, 8)}...</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Scheduled for: {new Date(s.scheduledAt).toLocaleString()}
                    </p>
                    {s.intervalSeconds && (
                      <p className="text-xs text-muted-foreground">
                        Interval: {s.intervalSeconds}s ± {s.jitterSeconds || 0}s
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Badge variant={getStatusColor(s.status) as any}>{s.status}</Badge>
                    {(s.status === "scheduled" || s.status === "running") && (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={cancelMutation.isPending}
                        onClick={() => {
                          if (confirm(`Are you sure you want to ${s.status === "running" ? "stop" : "cancel"} this campaign?`)) {
                            cancelMutation.mutate(s.id);
                          }
                        }}
                      >
                        {cancelMutation.isPending ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : s.status === "running" ? "Stop" : "Cancel"}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {visibleLiveRuns.length > 0 && (
            <div className="mt-6 space-y-3">
              <div className="text-sm font-medium text-foreground">Live Campaign Runs</div>
              {visibleLiveRuns.map((run) => {
                const progressValue = run.total > 0 ? Math.round((run.processed / run.total) * 100) : 0;
                return (
                  <div key={`${run.campaignId}-${run.startedAt}`} className="p-4 rounded-lg border bg-card/50 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{run.campaignName}</p>
                        <p className="text-xs text-muted-foreground">
                          {run.processed}/{run.total} processed • sent {run.sent} • failed {run.failed} • pending {run.pending}
                        </p>
                        {run.lastContactName && (
                          <p className="text-xs text-muted-foreground">
                            Current: {run.lastContactName} {run.lastContactPhone ? `(${run.lastContactPhone})` : ""}
                          </p>
                        )}
                        {run.error && (
                          <p className="text-xs text-destructive">Last error: {run.error}</p>
                        )}
                      </div>
                      <Badge variant={getStatusColor(run.status) as any}>{run.status}</Badge>
                    </div>
                    <Progress value={progressValue} className="h-2" />
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Schedule Dialog */}
      <Dialog open={showSchedule} onOpenChange={setShowSchedule}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Schedule Campaign</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Campaign</Label>
              <Select value={selectedCampaign} onValueChange={setSelectedCampaign}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a campaign" />
                </SelectTrigger>
                <SelectContent>
                  {campaigns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} />
              </div>
              <div>
                <Label>Time</Label>
                <Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Interval (seconds)</Label>
                <Input
                  type="number"
                  value={intervalSeconds}
                  onChange={(e) => setIntervalSeconds(e.target.value)}
                  min="1"
                />
              </div>
              <div>
                <Label>Jitter (seconds)</Label>
                <Input
                  type="number"
                  value={jitterSeconds}
                  onChange={(e) => setJitterSeconds(e.target.value)}
                  min="0"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Messages will be sent with a random delay between (interval - jitter) and (interval + jitter) seconds.
            </p>
            <Button
              onClick={() => scheduleMutation.mutate()}
              disabled={!selectedCampaign || !scheduleDate || !scheduleTime || scheduleMutation.isPending}
              className="w-full"
            >
              {scheduleMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              Schedule Campaign
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
