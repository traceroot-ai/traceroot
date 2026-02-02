import { redirect } from 'next/navigation';

interface Props {
  params: Promise<{ workspaceId: string }>;
}

export default async function WorkspaceSettingsPage({ params }: Props) {
  const { workspaceId } = await params;
  redirect(`/workspaces/${workspaceId}/settings/general`);
}
