CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" text NOT NULL,
	"count" integer NOT NULL
);
