import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Loader2, Search, Plus } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface Contact {
  id: string;
  name?: string | null;
  phoneNumber: string;
  isLead: string;
  updatedAt?: string;
}

interface Campaign {
  id: string;
  name: string;
}

export function ContactsPanel() {
  const [search, setSearch] = useState("");
  const [selectedCampaign, setSelectedCampaign] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: contacts = [], isLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts", search],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/contacts${search ? `?search=${encodeURIComponent(search)}` : ""}`);
      const data = await response.json();
      return data?.data || [];
    },
  });

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/campaigns");
      const data = await response.json();
      return data?.data || [];
    },
  });

  const visibleIds = useMemo(() => contacts.map((contact) => contact.id), [contacts]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const addToCampaignMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/contacts/add-to-campaign", {
        campaignId: selectedCampaign,
        contactIds: selectedIds,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Contacts added", description: `${selectedIds.length} contacts added to the campaign.` });
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to add contacts to campaign", variant: "destructive" });
    },
  });

  const toggleSelection = (contactId: string, checked: boolean) => {
    setSelectedIds((prev) => checked ? [...prev, contactId] : prev.filter((id) => id !== contactId));
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? visibleIds : []);
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Contacts
          </CardTitle>
          <Badge variant="secondary">{contacts.length}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or phone"
                className="pl-9"
              />
            </div>
            <Select value={selectedCampaign} onValueChange={setSelectedCampaign}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Choose campaign" />
              </SelectTrigger>
              <SelectContent>
                {campaigns.map((campaign) => (
                  <SelectItem key={campaign.id} value={campaign.id}>{campaign.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => addToCampaignMutation.mutate()}
              disabled={!selectedCampaign || selectedIds.length === 0 || addToCampaignMutation.isPending}
            >
              {addToCampaignMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
              Add to Campaign
            </Button>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <div className="grid grid-cols-[48px_1.3fr_1fr_120px] gap-3 px-4 py-3 bg-muted/40 text-xs font-medium text-muted-foreground">
              <div className="flex items-center">
                <Checkbox checked={allVisibleSelected} onCheckedChange={(value) => toggleSelectAll(Boolean(value))} />
              </div>
              <div>Name</div>
              <div>Phone</div>
              <div>Status</div>
            </div>

            {isLoading ? (
              <div className="p-8 flex items-center justify-center text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading contacts...
              </div>
            ) : contacts.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                No contacts found yet. Imported campaign contacts and scraped group members will appear here.
              </div>
            ) : (
              contacts.map((contact) => (
                <div key={contact.id} className="grid grid-cols-[48px_1.3fr_1fr_120px] gap-3 px-4 py-3 border-t items-center">
                  <div className="flex items-center">
                    <Checkbox
                      checked={selectedIds.includes(contact.id)}
                      onCheckedChange={(value) => toggleSelection(contact.id, Boolean(value))}
                    />
                  </div>
                  <div className="font-medium truncate">{contact.name || "Unnamed"}</div>
                  <div className="font-mono text-sm text-muted-foreground">{contact.phoneNumber}</div>
                  <div>
                    <Badge variant={contact.isLead === "true" ? "default" : "outline"}>
                      {contact.isLead === "true" ? "Lead" : "Contact"}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
