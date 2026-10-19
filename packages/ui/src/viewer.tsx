import { useEffect, useRef, useState } from 'react';
import { Button } from './controls.tsx';
import { Dialog } from './dialog.tsx';
import { stepIndex } from './media.ts';

export interface ViewerImage {
  src: string;
  name: string;
  /** Its file size, already formatted, e.g. `96 KB`. */
  size?: string;
  alt?: string;
}

export interface ImageViewerProps {
  /** The images of one message, in order. */
  images: ViewerImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/** One message's images full size, one at a time. ← and → step through them while it's open. */
export function ImageViewer({ images, index, onIndex, onClose }: ImageViewerProps) {
  const nav = useRef<HTMLSpanElement>(null);
  const stepped = useRef(false);
  // Pixel size, read once the image loads; keyed by source so a step never shows the last one's.
  const [dims, setDims] = useState<{ src: string; text: string }>();
  const image = images[index];
  const count = images.length;

  // Stepping to the first or last image disables the button that got there; after a step, keep
  // focus on the other one instead of losing it.
  useEffect(() => {
    if (!stepped.current) return;
    stepped.current = false;
    const at = document.activeElement;
    const lost = at === document.body || (at instanceof HTMLButtonElement && at.disabled);
    if (!lost) return;
    nav.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  });

  if (!image) return null;

  function step(by: -1 | 1) {
    const next = stepIndex(index, by, count);
    if (next === index) return;
    stepped.current = true;
    onIndex(next);
  }

  const meta = [image.size, dims?.src === image.src ? dims.text : undefined].filter(Boolean);

  return (
    <Dialog
      className="joc-viewer"
      label={image.name}
      title={image.name}
      meta={meta.join(' · ')}
      actions={
        count > 1 ? (
          <span className="joc-viewer__nav" ref={nav}>
            <span className="joc-viewer__pos">
              {index + 1} of {count}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon="chevronLeft"
              aria-label="Previous image"
              disabled={index === 0}
              onClick={() => step(-1)}
            />
            <Button
              variant="ghost"
              size="sm"
              icon="chevronRight"
              aria-label="Next image"
              disabled={index === count - 1}
              onClick={() => step(1)}
            />
          </span>
        ) : null
      }
      footer={count > 1 ? 'Esc closes · ← → move between images in this message' : 'Esc closes'}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          step(e.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
    >
      <img
        key={image.src}
        className="joc-viewer__img"
        src={image.src}
        alt={image.alt || image.name}
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          setDims({ src: image.src, text: `${w} × ${h}` });
        }}
      />
    </Dialog>
  );
}
