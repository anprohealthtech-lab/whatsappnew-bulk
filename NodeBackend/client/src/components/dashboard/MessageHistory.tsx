import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Search,
    RefreshCw,
    CheckCircle,
    Send,
    AlertTriangle,
    XCircle,
    FileText,
    MessageSquare
} from "lucide-react";

interface MessageHistoryProps {
    messages: any[];
    isLoading: boolean;
    filters: any;
    onFilterChange: (key: string, value: string) => void;
    onResend: (id: string) => void;
    formatTimestamp: (timestamp: string) => string;
}

export function MessageHistory({ messages, isLoading, filters, onFilterChange, onResend, formatTimestamp }: MessageHistoryProps) {
    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'delivered':
                return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200"><CheckCircle className="w-3 h-3 mr-1" />Delivered</Badge>;
            case 'sent':
                return <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 hover:bg-blue-200"><Send className="w-3 h-3 mr-1" />Sent</Badge>;
            case 'pending':
                return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 hover:bg-yellow-200"><AlertTriangle className="w-3 h-3 mr-1" />Pending</Badge>;
            case 'failed':
                return <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-200"><XCircle className="w-3 h-3 mr-1" />Failed</Badge>;
            default:
                return <Badge variant="outline">{status}</Badge>;
        }
    };

    const getTypeIcon = (type: string) => {
        switch (type) {
            case 'report':
                return <FileText className="w-4 h-4 text-purple-500" />;
            case 'text':
                return <MessageSquare className="w-4 h-4 text-blue-500" />;
            default:
                return <FileText className="w-4 h-4 text-gray-500" />;
        }
    };

    return (
        <Card className="border-none shadow-lg bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm">
            <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg font-semibold">Message History</CardTitle>
                <div className="flex items-center space-x-3">
                    <Select
                        value={filters.status}
                        onValueChange={(value) => onFilterChange('status', value)}
                    >
                        <SelectTrigger className="w-40 bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Status</SelectItem>
                            <SelectItem value="delivered">Delivered</SelectItem>
                            <SelectItem value="sent">Sent</SelectItem>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="failed">Failed</SelectItem>
                        </SelectContent>
                    </Select>

                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                        <Input
                            placeholder="Search messages..."
                            value={filters.search}
                            onChange={(e) => onFilterChange('search', e.target.value)}
                            className="pl-10 w-64 bg-white dark:bg-zinc-950 border-gray-200 dark:border-zinc-800"
                        />
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-zinc-800">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 dark:bg-zinc-900/50">
                            <tr>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Timestamp</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Recipient</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Type</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Content</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Status</th>
                                <th className="text-left py-4 px-6 font-medium text-muted-foreground">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-zinc-800 bg-white dark:bg-zinc-950">
                            {isLoading ? (
                                <tr>
                                    <td colSpan={6} className="py-8 text-center text-muted-foreground">
                                        <div className="flex items-center justify-center">
                                            <RefreshCw className="w-5 h-5 animate-spin mr-2" />
                                            Loading messages...
                                        </div>
                                    </td>
                                </tr>
                            ) : messages.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="py-12 text-center text-muted-foreground">
                                        No messages found matching your criteria
                                    </td>
                                </tr>
                            ) : (
                                messages.map((msg: any) => (
                                    <tr key={msg.id} className="hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors">
                                        <td className="py-4 px-6 text-muted-foreground whitespace-nowrap">
                                            {formatTimestamp(msg.createdAt)}
                                        </td>
                                        <td className="py-4 px-6 font-medium text-foreground">
                                            {msg.to}
                                        </td>
                                        <td className="py-4 px-6">
                                            <div className="flex items-center space-x-2">
                                                {getTypeIcon(msg.type)}
                                                <span className="capitalize text-muted-foreground">{msg.type}</span>
                                            </div>
                                        </td>
                                        <td className="py-4 px-6 max-w-xs truncate text-muted-foreground" title={msg.content}>
                                            {msg.content}
                                        </td>
                                        <td className="py-4 px-6">
                                            {getStatusBadge(msg.status)}
                                        </td>
                                        <td className="py-4 px-6">
                                            {msg.status === 'failed' && (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => onResend(msg.id)}
                                                    className="text-primary hover:text-primary hover:bg-primary/10"
                                                >
                                                    <RefreshCw className="w-4 h-4 mr-1" />
                                                    Resend
                                                </Button>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </CardContent>
        </Card>
    );
}
