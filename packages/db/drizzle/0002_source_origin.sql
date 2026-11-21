ALTER TABLE "sources" ADD COLUMN "origin" text DEFAULT 'ui' NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "file_path" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "file_error" text;