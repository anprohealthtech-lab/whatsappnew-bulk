import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Users,
  Download,
  Loader2,
  UserPlus,
  RefreshCw,
} from "lucide-react";

interface Group {
  id: string;
  subject: string;
  size: number;
}

interface GroupMember {
  id: string;
  phone: string;
  isAdmin: boolean;
}

interface Campaign {
  id: string;
  name: string;
}

export function GroupScraperPanel() {
  const [selectedGroup, setSelectedGroup] = useState("");
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [importCampaign, setImportCampaign] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: groups = [], isLoading: groupsLoading, refetch: refetchGroups } = useQuery<Group[]>({
    queryKey: ["/api/whatsapp/groups"],
    select: (data: any) => data?.data || data || [],
    enabled: true,
  });

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
    select: (data: any) => data?.data || data || [],
  });

  const scrapeMutation = useMutation({
    mutationFn: async (groupId: string) => {
      const res = await apiRequest("GET", `/api/whatsapp/groups/${encodeURIComponent(groupId)}/members`);
      return res.json();
    },
    onSuccess: (data) => {
      const memberList = data?.data || [];
      setMembers(memberList);
      toast({ title: "Members Scraped", description: `Found ${memberList.length} members` });
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!importCampaign || members.length === 0) throw new Error("Select a campaign and scrape members first");
      // Build Excel-compatible contact format
      const contacts = members.map((m) => ({
        name: m.phone,
        phone: m.phone,
      }));

      // Use the API to upload contacts as JSON
      const res = await apiRequest("POST", `/api/campaigns/${importCampaign}/contacts/upload-json`, {
        contacts,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Contacts Imported", description: `${members.length} contacts added to campaign` });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
    },
    onError: () => {
      // Fallback: download as CSV for manual import
      downloadCSV();
      toast({
        title: "Downloaded CSV",
        description: "Direct import not available. Download the CSV and upload it to your campaign.",
      });
    },
  });

  function downloadCSV() {
    const csvContent = "name,phone\n" + members.map((m) => `${m.phone},${m.phone}`).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `group-members-${selectedGroup.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Group Number Scraper
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => refetchGroups()} disabled={groupsLoading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${groupsLoading ? "animate-spin" : ""}`} />
            Refresh Groups
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Group Selection */}
          <div>
            <Label>Select WhatsApp Group</Label>
            {groupsLoading ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading groups...
              </div>
            ) : groups.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No groups found. Make sure WhatsApp is connected.
              </p>
            ) : (
              <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a group" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.subject} ({g.size} members)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {selectedGroup && (
            <Button
              onClick={() => scrapeMutation.mutate(selectedGroup)}
              disabled={scrapeMutation.isPending}
            >
              {scrapeMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <UserPlus className="w-4 h-4 mr-2" />
              )}
              Scrape Members
            </Button>
          )}

          {/* Members Result */}
          {members.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  {members.length} members found
                </p>
                <Button variant="outline" size="sm" onClick={downloadCSV}>
                  <Download className="w-4 h-4 mr-2" /> Download CSV
                </Button>
              </div>

              {/* Import to Campaign */}
              {campaigns.length > 0 && (
                <div className="flex gap-2">
                  <Select value={importCampaign} onValueChange={setImportCampaign}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Import to campaign..." />
                    </SelectTrigger>
                    <SelectContent>
                      {campaigns.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={() => importMutation.mutate()}
                    disabled={!importCampaign || importMutation.isPending}
                  >
                    {importMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Import"}
                  </Button>
                </div>
              )}

              {/* Member List Preview */}
              <div className="max-h-60 overflow-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-accent/30 sticky top-0">
                    <tr>
                      <th className="text-left p-2">#</th>
                      <th className="text-left p-2">Phone</th>
                      <th className="text-left p-2">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.slice(0, 100).map((m, i) => (
                      <tr key={m.id || i} className="border-t">
                        <td className="p-2 text-muted-foreground">{i + 1}</td>
                        <td className="p-2 font-mono text-xs">{m.phone}</td>
                        <td className="p-2">
                          {m.isAdmin && <Badge variant="secondary" className="text-xs">Admin</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {members.length > 100 && (
                  <p className="text-xs text-center text-muted-foreground py-2">
                    Showing 100 of {members.length} members
                  </p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
