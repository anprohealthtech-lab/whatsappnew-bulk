import {
    MessageSquare,
    History,
    Gauge,
    Megaphone,
    User
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarProps {
    activeSection: string;
    setActiveSection: (section: string) => void;
    setLocation: (path: string) => void;
}

export function Sidebar({ activeSection, setActiveSection, setLocation }: SidebarProps) {
    const menuItems = [
        { id: "dashboard", label: "Dashboard", icon: Gauge, action: () => setActiveSection("dashboard") },
        { id: "campaigns", label: "Campaigns", icon: Megaphone, action: () => setLocation("/campaigns") },
        { id: "history", label: "Message History", icon: History, action: () => setActiveSection("history") },
        { id: "auto-responses", label: "Auto-Responses", icon: MessageSquare, action: () => setActiveSection("auto-responses") },
    ];

    return (
        <div className="w-64 bg-card/50 backdrop-blur-xl border-r border-border flex flex-col h-full transition-all duration-300">
            <div className="p-6 border-b border-border/50">
                <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center ring-1 ring-primary/20">
                        <MessageSquare className="text-primary text-xl" />
                    </div>
                    <div>
                        <h1 className="text-lg font-bold text-foreground tracking-tight">WhatsApp</h1>
                        <p className="text-xs text-muted-foreground font-medium">Management System</p>
                    </div>
                </div>
            </div>

            <nav className="flex-1 px-3 py-6 space-y-1">
                {menuItems.map((item) => (
                    <button
                        key={item.id}
                        onClick={item.action}
                        className={cn(
                            "w-full flex items-center px-4 py-3 rounded-xl font-medium transition-all duration-200 group",
                            activeSection === item.id
                                ? "bg-primary text-primary-foreground shadow-lg shadow-primary/25"
                                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                        )}
                    >
                        <item.icon className={cn(
                            "w-5 h-5 mr-3 transition-transform duration-200",
                            activeSection === item.id ? "scale-110" : "group-hover:scale-110"
                        )} />
                        {item.label}
                    </button>
                ))}
            </nav>

            <div className="p-4 border-t border-border/50">
                <div className="flex items-center space-x-3 p-3 rounded-xl bg-accent/30 hover:bg-accent/50 transition-colors cursor-pointer">
                    <div className="w-9 h-9 bg-primary/10 rounded-full flex items-center justify-center">
                        <User className="text-primary text-sm" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">Admin User</p>
                        <p className="text-xs text-muted-foreground truncate">System Administrator</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
