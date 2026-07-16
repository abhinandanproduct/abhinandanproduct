'use client';

import * as React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => Promise<void> | void;
}

/** Hook returning a `confirm()` helper + the dialog element to render. */
export function useConfirm() {
  const [state, setState] = React.useState<ConfirmState>({
    open: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });
  const [loading, setLoading] = React.useState(false);

  const confirm = (opts: Omit<ConfirmState, 'open'>) =>
    setState({ ...opts, open: true });

  const close = () => setState((s) => ({ ...s, open: false }));

  const dialog = (
    <Dialog
      open={state.open}
      onClose={close}
      size="md"
      title={state.title}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await state.onConfirm();
                close();
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading && <Spinner />} Confirm
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{state.message}</p>
    </Dialog>
  );

  return { confirm, dialog };
}
