/**
 * The supporter lists — sponsors, promoters and testers — from the one file every
 * surface reads (public/sponsors.json: this site, the README script, the
 * app's About dialog).
 */
import data from '../../public/sponsors.json';

export interface Sponsor {
  name: string;
  since: string;
  github?: string;
  url?: string;
}

export interface Promoter {
  name: string;
  since: string;
  /** Where it was published: "Bilibili", "少数派", "YouTube", "Blog"… */
  platform: string;
  /** The article / video / post itself. */
  url: string;
  /** Their referral code, as in solomd.app/?ref=<code>. */
  ref?: string;
  github?: string;
  /** Shown as a card on the homepage, with `quote`. */
  featured?: boolean;
  quote?: string;
}

export interface Tester {
  name: string;
  since: string;
  /** What they tested, per language. */
  contribution: { en: string; zh: string };
  github?: string;
}

export const sponsors: Sponsor[] = (data as { sponsors: Sponsor[] }).sponsors ?? [];
export const promoters: Promoter[] = ((data as { promoters?: Promoter[] }).promoters ?? [])
  .slice()
  .sort((a, b) => (a.since < b.since ? 1 : -1));
export const testers: Tester[] = (data as { testers?: Tester[] }).testers ?? [];
export const featuredPromoters = promoters.filter((p) => p.featured && p.quote);

export const PROMOTE_ISSUE_URL =
  'https://github.com/zhitongblog/solomd/issues/new?template=promotion.yml';
export const PROMOTE_GITEE_URL = 'https://gitee.com/zhitong45/solomd/issues/new';
export const PROMOTE_EMAIL = 'slushy@139.com';
