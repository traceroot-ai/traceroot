export interface Integration {
  id: string;
  name: string;
  description: string;
  icon: string;
  categories: string[];
  connected: boolean;
  docs: string;
  token?: string | null;
}
