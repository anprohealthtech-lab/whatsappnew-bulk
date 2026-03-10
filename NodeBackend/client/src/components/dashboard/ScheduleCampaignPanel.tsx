import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
      case "failed": return "destructive";
      default: return "secondary";
    }
  }

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
                  <Badge variant={getStatusColor(s.status) as any}>{s.status}</Badge>
                </div>
              ))}
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
