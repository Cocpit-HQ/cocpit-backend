-- Migration to add width and height to post_media for zero-layout-shift image rendering
ALTER TABLE post_media
ADD COLUMN width INT,
ADD COLUMN height INT;
