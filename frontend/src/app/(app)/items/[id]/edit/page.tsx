'use client';

import { use } from 'react';
import { ItemForm } from '../../item-form';

export default function EditItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ItemForm itemId={Number(id)} />;
}
