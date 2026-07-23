import 'dotenv/config';
import express, { type Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import { registerRoutes } from "./routes";
import { serveStatic, log } from "./utils";
import { runMigrations } from "./migrate";
import { campaignService } from "./services/CampaignService";
import { leadFollowupService } from "./services/LeadFollowupService";
import { sessionManager } from "./services/WhatsAppSessionManager";
import { seedSuperAdmin } from "./seedSuperAdmin";
import { persistentFileService } from "./services/PersistentFileService";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const uploadsDir = persistentFileService.getUploadDirectory();
if (fs.existsSync(uploadsDir)) {
  app.use('/uploads', express.static(uploadsDir));
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  try {
    // Run DB migrations on startup — creates all tables if they don't exist
    // This ensures DO PostgreSQL has the schema before the app starts
    await runMigrations();

    // Seed super admin account from env vars (if configured)
    await seedSuperAdmin();

    campaignService.startScheduler();
    leadFollowupService.startScheduler();

    // Restore any previously connected WhatsApp sessions
    await sessionManager.restoreConnectedSessions();

    const server = await registerRoutes(app);

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = err.message || "Internal Server Error";

      res.status(status).json({ message });
      log(`Error: ${message}`);
    });

    // importantly only setup vite in development and after
    // setting up all the other routes so the catch-all route
    // doesn't interfere with the other routes
    if (process.env.NODE_ENV === "development" && process.env.npm_lifecycle_event !== "build") {
      try {
        log("Setting up Vite development server...");
        // Dynamic import to avoid loading Vite/Rollup in production
        const { setupVite } = await import("./vite-dev");
        await setupVite(app, server);
        log("Vite development server setup complete");
      } catch (error) {
        log(`Vite setup error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        console.error("Vite setup failed:", error);
        serveStatic(app);
      }
    } else {
      log("Production mode - serving static files");
      serveStatic(app);
    }

    // ALWAYS serve the app on the port specified in the environment variable PORT
    // Default to 3001 for DigitalOcean App Platform compatibility.
    // this serves both the API and the client.
    const port = parseInt(process.env.PORT || '3001', 10);
    server.listen(port, () => {
      log(`serving on port ${port}`);
    });

    // Global error handlers to prevent the process from crashing
    process.on('uncaughtException', (error) => {
      log(`Uncaught Exception: ${error.message}`);
      console.error(error);
      // Don't exit the process in production
    });

    process.on('unhandledRejection', (reason, promise) => {
      log(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
      console.error(reason);
      // Don't exit the process in production
    });

    // Graceful shutdown
    const shutdown = async () => {
      log('🛑 Graceful shutdown initiated...');
      campaignService.stopScheduler();
      leadFollowupService.stopScheduler();
      await sessionManager.shutdownAll();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000); // Force exit after 10s
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    log(`Failed to start server: ${error instanceof Error ? error.message : 'Unknown error'}`);
    console.error(error);
    process.exit(1);
  }
})();
