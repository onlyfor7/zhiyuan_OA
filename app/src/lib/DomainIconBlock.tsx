import { DOMAIN_ICONS, domainBg, domainColor } from "./icons";

/** 注册表图标块：全局统一的「彩底方块 + lucide 图标」承载（§4.3/§4.4） */
export function DomainIconBlock({ domain, size = 24, iconSize }: { domain: import("./icons").DomainKey; size?: number; iconSize?: number }) {
  const def = DOMAIN_ICONS[domain];
  const Icon = def.icon;
  return (
    <span
      className="p9a-iconblock domain-icon-block"
      aria-hidden="true"
      style={{ width: size, height: size, background: domainBg(domain), color: domainColor(domain) }}
    >
      <Icon size={iconSize ?? (size >= 40 ? 22 : size >= 32 ? 18 : 15)} />
    </span>
  );
}
