import { IsEmail, IsString, MinLength, MaxLength, Matches } from "class-validator";

export class RegisterDto {
  @IsEmail({}, { message: "Некорректный email" })
  email!: string;

  @IsString()
  @MinLength(3, { message: "Имя должно быть минимум 3 символа" })
  @MaxLength(64, { message: "Имя слишком длинное" })
  displayName!: string;

  @IsString()
  @MinLength(8, { message: "Пароль должен быть минимум 8 символов" })
  @Matches(/[A-Za-z]/, { message: "Пароль должен содержать буквы" })
  @Matches(/[0-9]/, { message: "Пароль должен содержать цифры" })
  password!: string;
}
