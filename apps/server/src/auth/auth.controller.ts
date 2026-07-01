import { Body, Controller, Post } from "@nestjs/common";
import { AuthService, type AuthTokens } from "./auth.service";
import { RegisterDto, LoginDto, GuestDto } from "./dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  async register(@Body() dto: RegisterDto): Promise<AuthTokens> {
    return this.auth.register(dto);
  }

  @Post("login")
  async login(@Body() dto: LoginDto): Promise<AuthTokens> {
    return this.auth.login(dto);
  }

  @Post("guest")
  async guest(@Body() dto: GuestDto): Promise<AuthTokens> {
    return this.auth.createGuest(dto);
  }
}
