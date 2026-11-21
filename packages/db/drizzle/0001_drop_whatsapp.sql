-- The WhatsApp channel was removed (#44). Clear rows that would no longer pass the ChannelType schema.
DELETE FROM "channel_addresses" WHERE "channel" = 'whatsapp';--> statement-breakpoint
DELETE FROM "deliveries" WHERE "channel" = 'whatsapp';--> statement-breakpoint
UPDATE "channel_prefs" SET "in_hours" = array_remove("in_hours", 'whatsapp'), "off_hours" = array_remove("off_hours", 'whatsapp') WHERE 'whatsapp' = ANY("in_hours") OR 'whatsapp' = ANY("off_hours");
