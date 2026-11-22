-- Run once in the Supabase SQL editor when using STORAGE_PROVIDER=supabase.
-- Private bucket: the server issues short-lived signed URLs for uploads, previews and platform pulls.
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 1073741824)
on conflict (id) do nothing;
