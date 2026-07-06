import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { UserRepository } from "../db/repositories/user.repository";
import type { RegisterDto, LoginDto, GuestDto } from "./dto";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
  isGuest: boolean;
}

@Injectable()
export class AuthService {
  private static readonly BCRYPT_ROUNDS = 12;

  constructor(
    @Inject(forwardRef(() => UserRepository)) private readonly users: UserRepository,
    @Inject(forwardRef(() => JwtService)) private readonly jwt: JwtService,
  ) {
    if (!this.users) {
      console.error("[AuthService] UserRepository не заинжектирован!");
    }
  }

  async register(dto: RegisterDto): Promise<AuthTokens> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException("Email уже зарегистрирован");
    }

    const passwordHash = await bcrypt.hash(dto.password, AuthService.BCRYPT_ROUNDS);

    const user = await this.users.create({
      email: dto.email,
      displayName: dto.displayName,
      passwordHash,
      isGuest: false,
    });

    return this.issueTokens(user.id, false);
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    const user = await this.users.findByEmail(dto.email);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("Неверные учётные данные");
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException("Неверные учётные данные");
    }

    return this.issueTokens(user.id, false);
  }

  async createGuest(dto: GuestDto): Promise<AuthTokens> {
    const guestId = randomUUID();
    const user = await this.users.create({
      displayName: dto.displayName || "Гость",
      isGuest: true,
      guestId,
    });
    return this.issueTokens(user.id, true);
  }

  async verifyToken(token: string) {
    return this.jwt.verifyAsync<{ sub: string; isGuest: boolean }>(token);
  }

  private async issueTokens(userId: string, isGuest: boolean): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync({ sub: userId, isGuest }, { expiresIn: "15m" });
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, isGuest, type: "refresh" },
      { expiresIn: "30d" },
    );
    return { accessToken, refreshToken, userId, isGuest };
  }
}
