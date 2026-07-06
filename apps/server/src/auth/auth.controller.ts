import { Body, Controller, Post, Inject, forwardRef } from "@nestjs/common";
import { AuthService, type AuthTokens } from "./auth.service";
import { RegisterDto, LoginDto, GuestDto } from "./dto";

@Controller("auth")
export class AuthController {
  constructor(@Inject(forwardRef(() => AuthService)) private readonly auth: AuthService) {
    if (!this.auth) {
      console.error("[AuthController] AuthService не заинжектирован!");
    }
  }

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
