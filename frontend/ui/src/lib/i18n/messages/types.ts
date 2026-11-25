/** A translation of some message groups: any group, and any key in it, may be left out. */
export type PartialGroups<Groups> = { [Group in keyof Groups]?: Partial<Groups[Group]> };
