export interface TemplateObjectPaths {
  readonly source: string;
  readonly previews: {
    readonly desktop: string;
    readonly tablet: string;
    readonly mobile: string;
  };
}

export function templateObjectPaths(templateKey: string, version: number): TemplateObjectPaths {
  const prefix = `sites/templates/${templateKey}/v${version}`;
  return {
    source: `${prefix}/source/template.zip`,
    previews: {
      desktop: `${prefix}/previews/desktop.webp`,
      tablet: `${prefix}/previews/tablet.webp`,
      mobile: `${prefix}/previews/mobile.webp`,
    },
  };
}
