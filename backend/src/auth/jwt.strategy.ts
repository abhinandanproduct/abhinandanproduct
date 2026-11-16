import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../common/decorators';
import { jwtSecret } from './jwt-secret';

export interface JwtPayload {
  sub: number;
  username: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      // Accept the token from the Authorization header (normal API calls) OR a
      // `?t=` query param. The query fallback exists only so file downloads
      // (PDFs opened in a new browser tab / <a> link) can authenticate — a tab
      // navigation can't carry an Authorization header. Header is tried first.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => (req?.query?.t ? String(req.query.t) : null),
      ]),
      ignoreExpiration: false,
      secretOrKey: jwtSecret(),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    return { id: payload.sub, username: payload.username, role: payload.role };
  }
}
