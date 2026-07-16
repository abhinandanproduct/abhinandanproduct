'use client';

import * as React from 'react';
import { UploadCloud, X } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { fileUrl } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

interface ImageUploadProps {
  module: string;
  multiple?: boolean;
  /** Already-uploaded relative paths. */
  value: string[];
  onChange: (paths: string[]) => void;
}

/** Uploads images to the API immediately and tracks their relative paths. */
export function ImageUpload({ module, multiple, value, onChange }: ImageUploadProps) {
  const [uploading, setUploading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files)) {
        const res = await Api.upload(file, module, 'image');
        uploaded.push(res.path);
      }
      onChange(multiple ? [...value, ...uploaded] : uploaded.slice(-1));
    } catch (e) {
      toast.error(getApiError(e).message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-muted/30 px-4 py-6 text-center transition-colors hover:bg-muted/60"
      >
        {uploading ? (
          <Spinner className="size-5 text-primary" />
        ) : (
          <UploadCloud className="size-6 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">Click to upload {multiple ? 'images' : 'an image'}</span>
        <span className="text-xs text-muted-foreground">JPG / PNG / GIF / WEBP · max 5 MB</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={multiple}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />

      {value.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {value.map((path) => (
            <div key={path} className="relative">
              <a href={fileUrl(path)} target="_blank" rel="noreferrer" title="Open full image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={fileUrl(path)}
                  alt="preview"
                  className="size-20 rounded-lg border border-border object-cover transition-opacity hover:opacity-80"
                />
              </a>
              <button
                type="button"
                onClick={() => onChange(value.filter((p) => p !== path))}
                className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full border-2 border-card bg-destructive text-destructive-foreground"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
